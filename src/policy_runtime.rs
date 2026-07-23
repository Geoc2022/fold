//! Durable server-side policy evaluation and action delivery.

use policy::evaluate_policy_safe;
use serde::{Deserialize, Serialize};
use worker::{console_error, console_log, D1Database, Env, Error, MessageBuilder, Queue, Result};

use crate::policy_planner::{
    reconcile, ActionChange, ActionSnapshot, ActionStatus, InstanceSnapshot, ReconcileInput,
};
use crate::policy_store::{self, PolicyScope};
use crate::policy_timeline::{collect_timeline, TimelineAction};
use crate::{db, policy_env, push, util};

const MAX_QUEUE_DELAY_SECONDS: u32 = 86_400;
const TIME_EVALUATION_INTERVAL_MS: i64 = 60_000;
const STALE_JOB_MS: i64 = 5 * 60_000;
const MAX_CAUSAL_DEPTH: i64 = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "job", rename_all = "snake_case")]
pub enum PolicyJob {
    Evaluate { event_id: String },
    Action { action_id: String },
    Push { delivery_id: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct PushTestQueued {
    pub notification_id: String,
    pub deliveries_queued: i64,
}

#[derive(Deserialize)]
struct EventRow {
    id: String,
    activity_id: String,
    run_id: Option<String>,
    causal_depth: i64,
}

#[derive(Deserialize)]
struct OwnerRow {
    person_id: String,
}

#[derive(Deserialize)]
struct InstanceRow {
    id: String,
    rule_version: i64,
    active: i64,
    occurrence: i64,
    origin_at: Option<i64>,
}

#[derive(Deserialize)]
struct StoredActionRow {
    occurrence: i64,
    action_key: String,
    sequence_index: i64,
    payload_json: String,
    due_at: i64,
    status: String,
}

#[derive(Deserialize)]
struct DueIdRow {
    id: String,
}

#[derive(Deserialize)]
struct DueEvaluationRow {
    activity_id: String,
    run_id: String,
}

#[derive(Deserialize)]
struct ActionExecutionRow {
    id: String,
    instance_id: String,
    status: String,
    due_at: i64,
    payload_json: String,
    occurrence: i64,
    action_key: String,
    sequence_index: i64,
    person_id: String,
    activity_id: String,
    run_id: String,
    activity_title: String,
    activity_code: String,
    max_commit_seconds: i64,
    causal_depth: i64,
}

#[derive(Deserialize)]
struct CurrentParticipationRow {
    state: String,
    arrival_at: Option<i64>,
}

#[derive(Deserialize)]
struct DeliveryRow {
    id: String,
    notification_id: String,
    subscription_id: String,
    attempts: i64,
    title: Option<String>,
    message: String,
    url: Option<String>,
    dedupe_key: Option<String>,
    created_at: i64,
    endpoint: String,
    p256dh: String,
    auth: String,
}

fn jobs(env: &Env) -> Result<Queue> {
    env.queue("JOBS")
}

async fn enqueue(env: &Env, job: PolicyJob, delay_ms: i64) -> Result<()> {
    let delay_seconds = ((delay_ms.max(0) + 999) / 1000) as u32;
    let message = MessageBuilder::new(job)
        .delay_seconds(delay_seconds.min(MAX_QUEUE_DELAY_SECONDS))
        .build();
    jobs(env)?.send(message).await
}

pub async fn emit_event(
    env: &Env,
    db: &D1Database,
    activity_id: &str,
    run_id: Option<&str>,
    kind: &str,
    actor_id: Option<&str>,
    causal_depth: i64,
) -> Result<()> {
    if causal_depth > MAX_CAUSAL_DEPTH {
        console_error!("policy event causal depth exceeded for activity {activity_id}");
        return Ok(());
    }
    let id = util::new_id();
    let now = util::now_ms();
    db.prepare(
        "INSERT INTO domain_events \
           (id, activity_id, run_id, kind, actor_id, causal_depth, occurred_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&[
        db::s(&id),
        db::s(activity_id),
        db::os(run_id),
        db::s(kind),
        db::os(actor_id),
        db::i(causal_depth),
        db::i(now),
    ])?
    .run()
    .await?;

    publish_event(env, db, &id, now).await
}

async fn publish_event(env: &Env, db: &D1Database, id: &str, now: i64) -> Result<()> {
    if enqueue(
        env,
        PolicyJob::Evaluate {
            event_id: id.to_string(),
        },
        0,
    )
    .await
    .is_ok()
    {
        db.prepare("UPDATE domain_events SET queued_at = ?1 WHERE id = ?2")
            .bind(&[db::i(now), db::s(&id)])?
            .run()
            .await?;
    }
    Ok(())
}

pub async fn policy_set_changed(
    env: &Env,
    db: &D1Database,
    person_id: &str,
    scope: PolicyScope,
    activity_id: Option<&str>,
) -> Result<()> {
    #[derive(Deserialize)]
    struct ActivityContext {
        activity_id: String,
        run_id: String,
    }

    let contexts = match scope {
        PolicyScope::Room => {
            let Some(activity_id) = activity_id else {
                return Ok(());
            };
            db.prepare(
                "SELECT id AS activity_id, current_run_id AS run_id \
                 FROM activities WHERE id = ?1 AND current_run_id IS NOT NULL",
            )
            .bind(&[db::s(activity_id)])?
            .all()
            .await?
            .results::<ActivityContext>()?
        }
        PolicyScope::Home => db
            .prepare(
                "SELECT DISTINCT a.id AS activity_id, a.current_run_id AS run_id \
                 FROM activities a \
                 JOIN participations p ON p.run_id = a.current_run_id \
                 WHERE p.person_id = ?1 AND a.current_run_id IS NOT NULL \
                 LIMIT 50",
            )
            .bind(&[db::s(person_id)])?
            .all()
            .await?
            .results::<ActivityContext>()?,
    };
    for context in contexts {
        emit_event(
            env,
            db,
            &context.activity_id,
            Some(&context.run_id),
            "policy_set_changed",
            Some(person_id),
            0,
        )
        .await?;
    }
    Ok(())
}

pub async fn process_job(env: &Env, job: &PolicyJob) -> Result<()> {
    let db = env.d1("DB")?;
    match job {
        PolicyJob::Evaluate { event_id } => process_event(env, &db, event_id).await,
        PolicyJob::Action { action_id } => process_action(env, &db, action_id).await,
        PolicyJob::Push { delivery_id } => process_delivery(env, &db, delivery_id).await,
    }
}

async fn process_event(env: &Env, db: &D1Database, event_id: &str) -> Result<()> {
    let Some(event) = db
        .prepare(
            "SELECT id, activity_id, run_id, causal_depth FROM domain_events \
             WHERE id = ?1 AND processed_at IS NULL",
        )
        .bind(&[db::s(event_id)])?
        .first::<EventRow>(None)
        .await?
    else {
        return Ok(());
    };
    if let Some(run_id) = event.run_id.as_deref() {
        evaluate_activity(env, db, &event.activity_id, run_id, event.causal_depth).await?;
    }
    db.prepare("UPDATE domain_events SET processed_at = ?1 WHERE id = ?2")
        .bind(&[db::i(util::now_ms()), db::s(&event.id)])?
        .run()
        .await?;
    console_log!(
        "[fold:policy] event_processed event={} activity={} run={}",
        event.id,
        event.activity_id,
        event.run_id.as_deref().unwrap_or("none")
    );
    Ok(())
}

async fn evaluate_activity(
    env: &Env,
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    causal_depth: i64,
) -> Result<()> {
    let now = util::now_ms();
    deactivate_ineligible_instances(db, activity_id, run_id, now).await?;
    let owners = db
        .prepare(
            "SELECT DISTINCT ps.person_id \
             FROM policy_sets ps \
             WHERE (ps.scope = 'home' OR (ps.scope = 'room' AND ps.activity_id = ?1)) \
               AND (EXISTS (SELECT 1 FROM participations p \
                            WHERE p.run_id = ?2 AND p.person_id = ps.person_id) \
                    OR EXISTS (SELECT 1 FROM room_presence rp \
                               WHERE rp.activity_id = ?1 AND rp.person_id = ps.person_id \
                                 AND rp.last_seen_at >= ?3))",
        )
        .bind(&[
            db::s(activity_id),
            db::s(run_id),
            db::i(now - crate::api::DESPONDENT_MS),
        ])?
        .all()
        .await?
        .results::<OwnerRow>()?;

    for owner in owners {
        let Some(set) = policy_store::load_effective_policy_set(db, &owner.person_id, activity_id)
            .await
            .map_err(|error| Error::RustError(error.to_string()))?
        else {
            continue;
        };
        let eval_env = policy_env::build_env(
            db,
            activity_id,
            run_id,
            &owner.person_id,
            &set.timezone,
            now,
            now - crate::api::DESPONDENT_MS,
        )
        .await?;
        deactivate_shadowed_instances(
            db,
            &owner.person_id,
            activity_id,
            run_id,
            &set.id,
            set.scope,
            now,
        )
        .await?;
        deactivate_disabled_instances(db, activity_id, run_id, &set.id, now).await?;
        for rule in set.rules.iter().filter(|rule| rule.enabled) {
            let result = evaluate_policy_safe(&rule.compiled, &eval_env);
            if let Some(error) = result.error {
                console_error!("policy rule {} evaluation failed: {error}", rule.id);
                continue;
            }
            let timeline = result.fired.as_ref().map(collect_timeline);
            console_log!(
                "[fold:policy] rule_evaluated rule={} version={} activity={} fired={} actions={}",
                rule.id,
                rule.version,
                activity_id,
                timeline.is_some(),
                timeline
                    .as_ref()
                    .map_or(0, |timeline| timeline.entries.len())
            );
            reconcile_rule(
                env,
                db,
                &rule.id,
                rule.version,
                rule.time_dependent,
                activity_id,
                run_id,
                timeline,
                causal_depth,
                now,
            )
            .await?;
        }
    }
    Ok(())
}

async fn deactivate_disabled_instances(
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    set_id: &str,
    now: i64,
) -> Result<()> {
    db.prepare(
        "UPDATE policy_actions SET status = 'cancelled', updated_at = ?1 \
         WHERE status = 'pending' AND instance_id IN ( \
           SELECT pi.id FROM policy_instances pi \
           JOIN policy_rules pr ON pr.id = pi.rule_id \
           WHERE pi.activity_id = ?2 AND pi.run_id = ?3 \
             AND pr.policy_set_id = ?4 AND pr.enabled = 0)",
    )
    .bind(&[db::i(now), db::s(activity_id), db::s(run_id), db::s(set_id)])?
    .run()
    .await?;
    db.prepare(
        "UPDATE policy_instances SET active = 0, origin_at = NULL, next_evaluate_at = NULL, \
           last_evaluated_at = ?1 WHERE activity_id = ?2 AND run_id = ?3 AND rule_id IN ( \
             SELECT id FROM policy_rules WHERE policy_set_id = ?4 AND enabled = 0)",
    )
    .bind(&[db::i(now), db::s(activity_id), db::s(run_id), db::s(set_id)])?
    .run()
    .await?;
    Ok(())
}

async fn deactivate_ineligible_instances(
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    now: i64,
) -> Result<()> {
    let ineligible = "NOT EXISTS (SELECT 1 FROM participations p \
                        WHERE p.run_id = pi.run_id AND p.person_id = ps.person_id) \
                      AND NOT EXISTS (SELECT 1 FROM room_presence rp \
                        WHERE rp.activity_id = pi.activity_id AND rp.person_id = ps.person_id \
                          AND rp.last_seen_at >= ?4)";
    let cancel_sql = format!(
        "UPDATE policy_actions SET status = 'cancelled', updated_at = ?1 \
         WHERE status = 'pending' AND instance_id IN ( \
           SELECT pi.id FROM policy_instances pi \
           JOIN policy_rules pr ON pr.id = pi.rule_id \
           JOIN policy_sets ps ON ps.id = pr.policy_set_id \
           WHERE pi.activity_id = ?2 AND pi.run_id = ?3 AND {ineligible})"
    );
    db.prepare(cancel_sql)
        .bind(&[
            db::i(now),
            db::s(activity_id),
            db::s(run_id),
            db::i(now - crate::api::DESPONDENT_MS),
        ])?
        .run()
        .await?;
    let instance_sql = format!(
        "UPDATE policy_instances SET active = 0, origin_at = NULL, next_evaluate_at = NULL, \
           last_evaluated_at = ?1 \
         WHERE id IN (SELECT pi.id FROM policy_instances pi \
           JOIN policy_rules pr ON pr.id = pi.rule_id \
           JOIN policy_sets ps ON ps.id = pr.policy_set_id \
           WHERE pi.activity_id = ?2 AND pi.run_id = ?3 AND {ineligible})"
    );
    db.prepare(instance_sql)
        .bind(&[
            db::i(now),
            db::s(activity_id),
            db::s(run_id),
            db::i(now - crate::api::DESPONDENT_MS),
        ])?
        .run()
        .await?;
    Ok(())
}

async fn deactivate_shadowed_instances(
    db: &D1Database,
    person_id: &str,
    activity_id: &str,
    run_id: &str,
    effective_set_id: &str,
    _effective_scope: PolicyScope,
    now: i64,
) -> Result<()> {
    db.prepare(
        "UPDATE policy_actions SET status = 'cancelled', updated_at = ?1 \
         WHERE status = 'pending' AND instance_id IN ( \
           SELECT pi.id FROM policy_instances pi \
           JOIN policy_rules pr ON pr.id = pi.rule_id \
           JOIN policy_sets ps ON ps.id = pr.policy_set_id \
           WHERE ps.person_id = ?2 AND pi.activity_id = ?3 AND pi.run_id = ?4 \
             AND ps.id != ?5)",
    )
    .bind(&[
        db::i(now),
        db::s(person_id),
        db::s(activity_id),
        db::s(run_id),
        db::s(effective_set_id),
    ])?
    .run()
    .await?;
    db.prepare(
        "UPDATE policy_instances SET active = 0, origin_at = NULL, next_evaluate_at = NULL, \
           last_evaluated_at = ?1 \
         WHERE activity_id = ?3 AND run_id = ?4 AND rule_id IN ( \
           SELECT pr.id FROM policy_rules pr \
           JOIN policy_sets ps ON ps.id = pr.policy_set_id \
           WHERE ps.person_id = ?2 AND ps.id != ?5)",
    )
    .bind(&[
        db::i(now),
        db::s(person_id),
        db::s(activity_id),
        db::s(run_id),
        db::s(effective_set_id),
    ])?
    .run()
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn reconcile_rule(
    env: &Env,
    db: &D1Database,
    rule_id: &str,
    rule_version: i64,
    time_dependent: bool,
    activity_id: &str,
    run_id: &str,
    timeline: Option<crate::policy_timeline::Timeline>,
    causal_depth: i64,
    now: i64,
) -> Result<()> {
    let instance_row = db
        .prepare(
            "SELECT id, rule_version, active, occurrence, origin_at \
             FROM policy_instances WHERE rule_id = ?1 AND activity_id = ?2 AND run_id = ?3",
        )
        .bind(&[db::s(rule_id), db::s(activity_id), db::s(run_id)])?
        .first::<InstanceRow>(None)
        .await?;
    let instance_id = instance_row
        .as_ref()
        .map(|row| row.id.clone())
        .unwrap_or_else(util::new_id);
    let stored_actions = if instance_row.is_some() {
        db.prepare(
            "SELECT occurrence, action_key, sequence_index, payload_json, due_at, status \
             FROM policy_actions WHERE instance_id = ?1",
        )
        .bind(&[db::s(&instance_id)])?
        .all()
        .await?
        .results::<StoredActionRow>()?
    } else {
        Vec::new()
    };
    let actions = stored_actions
        .into_iter()
        .map(action_snapshot)
        .collect::<Result<Vec<_>>>()?;
    let snapshot = instance_row.map(|row| InstanceSnapshot {
        rule_version: row.rule_version,
        active: row.active != 0,
        occurrence: row.occurrence,
        origin_at_ms: row.origin_at,
    });
    let reconciliation = reconcile(ReconcileInput {
        now_ms: now,
        rule_version,
        evaluated: timeline,
        instance: snapshot,
        actions,
    })
    .map_err(|error| Error::RustError(format!("policy reconciliation failed: {error:?}")))?;
    let next_evaluate_at = time_dependent.then_some(now + TIME_EVALUATION_INTERVAL_MS);

    db.prepare(
        "INSERT INTO policy_instances \
           (id, rule_id, activity_id, run_id, rule_version, active, occurrence, origin_at, \
            next_evaluate_at, last_evaluated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(rule_id, activity_id, run_id) DO UPDATE SET \
           rule_version = excluded.rule_version, active = excluded.active, \
           occurrence = excluded.occurrence, origin_at = excluded.origin_at, \
           next_evaluate_at = excluded.next_evaluate_at, last_evaluated_at = excluded.last_evaluated_at",
    )
    .bind(&[
        db::s(&instance_id),
        db::s(rule_id),
        db::s(activity_id),
        db::s(run_id),
        db::i(reconciliation.instance.rule_version),
        db::i(reconciliation.instance.active as i64),
        db::i(reconciliation.instance.occurrence),
        db::oi(reconciliation.instance.origin_at_ms),
        db::oi(next_evaluate_at),
        db::i(now),
    ])?
    .run()
    .await?;

    for change in reconciliation.action_changes {
        match change {
            ActionChange::Cancel(action) => {
                db.prepare(
                    "UPDATE policy_actions SET status = 'cancelled', updated_at = ?1 \
                     WHERE instance_id = ?2 AND occurrence = ?3 AND action_key = ?4 \
                       AND status = 'pending'",
                )
                .bind(&[
                    db::i(now),
                    db::s(&instance_id),
                    db::i(action.occurrence),
                    db::s(&action.key),
                ])?
                .run()
                .await?;
            }
            ActionChange::Insert(action) => {
                persist_action(db, &instance_id, &action, causal_depth, now, false).await?;
            }
            ActionChange::Update(action) => {
                persist_action(db, &instance_id, &action, causal_depth, now, true).await?;
            }
        }
    }
    enqueue_instance_actions(env, db, &instance_id, now).await
}

fn action_snapshot(row: StoredActionRow) -> Result<ActionSnapshot> {
    let action = serde_json::from_str(&row.payload_json)
        .map_err(|error| Error::RustError(format!("invalid stored policy action: {error}")))?;
    let status = match row.status.as_str() {
        "pending" => ActionStatus::Pending,
        "running" => ActionStatus::Running,
        "completed" => ActionStatus::Completed,
        "cancelled" => ActionStatus::Cancelled,
        "failed" => ActionStatus::Failed,
        other => return Err(Error::RustError(format!("invalid action status '{other}'"))),
    };
    Ok(ActionSnapshot {
        occurrence: row.occurrence,
        key: row.action_key,
        sequence_index: row.sequence_index.max(0) as usize,
        due_at_ms: row.due_at,
        action,
        status,
    })
}

async fn persist_action(
    db: &D1Database,
    instance_id: &str,
    action: &ActionSnapshot,
    causal_depth: i64,
    now: i64,
    update: bool,
) -> Result<()> {
    let payload = serde_json::to_string(&action.action)
        .map_err(|error| Error::RustError(format!("policy action encode failed: {error}")))?;
    let kind = match action.action {
        TimelineAction::Notify { .. } => "notify",
        TimelineAction::SetState { .. } => "state",
    };
    if update {
        db.prepare(
            "UPDATE policy_actions SET sequence_index = ?1, kind = ?2, payload_json = ?3, \
               due_at = ?4, causal_depth = ?5, status = 'pending', queued_at = NULL, \
               last_error = NULL, updated_at = ?6 \
             WHERE instance_id = ?7 AND occurrence = ?8 AND action_key = ?9",
        )
        .bind(&[
            db::i(action.sequence_index as i64),
            db::s(kind),
            db::s(&payload),
            db::i(action.due_at_ms),
            db::i(causal_depth),
            db::i(now),
            db::s(instance_id),
            db::i(action.occurrence),
            db::s(&action.key),
        ])?
        .run()
        .await?;
    } else {
        db.prepare(
            "INSERT OR IGNORE INTO policy_actions \
               (id, instance_id, occurrence, action_key, sequence_index, kind, payload_json, \
                due_at, causal_depth, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)",
        )
        .bind(&[
            db::s(&util::new_id()),
            db::s(instance_id),
            db::i(action.occurrence),
            db::s(&action.key),
            db::i(action.sequence_index as i64),
            db::s(kind),
            db::s(&payload),
            db::i(action.due_at_ms),
            db::i(causal_depth),
            db::i(now),
        ])?
        .run()
        .await?;
    }
    Ok(())
}

async fn enqueue_instance_actions(
    env: &Env,
    db: &D1Database,
    instance_id: &str,
    now: i64,
) -> Result<()> {
    #[derive(Deserialize)]
    struct ActionToQueue {
        id: String,
        due_at: i64,
    }
    let rows = db
        .prepare(
            "SELECT id, due_at FROM policy_actions \
             WHERE instance_id = ?1 AND status = 'pending' \
               AND due_at <= ?2 AND (queued_at IS NULL OR queued_at < ?3)",
        )
        .bind(&[
            db::s(instance_id),
            db::i(now + i64::from(MAX_QUEUE_DELAY_SECONDS) * 1000),
            db::i(now - STALE_JOB_MS),
        ])?
        .all()
        .await?
        .results::<ActionToQueue>()?;
    for row in rows {
        enqueue(
            env,
            PolicyJob::Action {
                action_id: row.id.clone(),
            },
            row.due_at - now,
        )
        .await?;
        db.prepare("UPDATE policy_actions SET queued_at = ?1 WHERE id = ?2 AND status = 'pending'")
            .bind(&[db::i(now), db::s(&row.id)])?
            .run()
            .await?;
    }
    Ok(())
}

async fn process_action(env: &Env, db: &D1Database, action_id: &str) -> Result<()> {
    let now = util::now_ms();
    let Some(row) = load_action(db, action_id).await? else {
        return Ok(());
    };
    if row.status != "pending" {
        return Ok(());
    }
    if cancel_action_if_stale(db, action_id, now).await? {
        return Ok(());
    }
    if !action_owner_is_eligible(db, &row, now).await? {
        db.prepare(
            "UPDATE policy_actions SET status = 'cancelled', updated_at = ?1 \
             WHERE id = ?2 AND status = 'pending'",
        )
        .bind(&[db::i(now), db::s(action_id)])?
        .run()
        .await?;
        return Ok(());
    }
    if let Some(blocker) = earlier_action_blocker(db, &row).await? {
        if blocker == "failed" {
            db.prepare(
                "UPDATE policy_actions SET status = 'failed', \
                   last_error = 'earlier sequential action failed', updated_at = ?1 \
                 WHERE id = ?2 AND status = 'pending'",
            )
            .bind(&[db::i(now), db::s(action_id)])?
            .run()
            .await?;
            return Ok(());
        }
        return enqueue(
            env,
            PolicyJob::Action {
                action_id: action_id.to_string(),
            },
            1_000,
        )
        .await;
    }
    if row.due_at > now {
        return enqueue(
            env,
            PolicyJob::Action {
                action_id: action_id.to_string(),
            },
            row.due_at - now,
        )
        .await;
    }
    let claimed = db
        .prepare(
            "UPDATE policy_actions SET status = 'running', attempts = attempts + 1, updated_at = ?1 \
             WHERE id = ?2 AND status = 'pending' AND due_at <= ?1 \
               AND EXISTS (SELECT 1 FROM policy_instances pi \
                 JOIN policy_rules pr ON pr.id = pi.rule_id \
                 JOIN policy_sets ps ON ps.id = pr.policy_set_id \
                 WHERE pi.id = policy_actions.instance_id AND pi.active = 1 \
                   AND pi.rule_version = pr.version AND pr.enabled = 1 \
                   AND ps.id = COALESCE( \
                     (SELECT room.id FROM policy_sets room \
                      WHERE room.person_id = ps.person_id AND room.scope = 'room' \
                        AND room.activity_id = pi.activity_id LIMIT 1), \
                     (SELECT home.id FROM policy_sets home \
                      WHERE home.person_id = ps.person_id AND home.scope = 'home' LIMIT 1)))",
        )
        .bind(&[db::i(now), db::s(action_id)])?
        .run()
        .await?;
    if claimed.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 0 {
        return Ok(());
    }
    let row = load_action(db, action_id)
        .await?
        .ok_or_else(|| Error::RustError("claimed policy action disappeared".to_string()))?;
    let action: TimelineAction = serde_json::from_str(&row.payload_json)
        .map_err(|error| Error::RustError(format!("invalid policy action payload: {error}")))?;
    let result = match action {
        TimelineAction::Notify { message } => {
            create_policy_notification(env, db, &row, &message).await
        }
        TimelineAction::SetState {
            state,
            eta_delta_secs,
        } => apply_state_action(env, db, &row, &state, eta_delta_secs).await,
    };
    match result {
        Ok(()) => {
            db.prepare(
                "UPDATE policy_actions SET status = 'completed', last_error = NULL, updated_at = ?1 \
                 WHERE id = ?2 AND status = 'running'",
            )
            .bind(&[db::i(util::now_ms()), db::s(action_id)])?
            .run()
            .await?;
            Ok(())
        }
        Err(error) => {
            let error_message = error.to_string();
            let permanent = error_message.contains("activity is full")
                || error_message.contains("UNIQUE constraint failed");
            db.prepare(
                "UPDATE policy_actions SET \
                   status = CASE WHEN ?1 != 0 OR attempts >= 10 THEN 'failed' ELSE 'pending' END, \
                   queued_at = NULL, last_error = ?2, updated_at = ?3 \
                 WHERE id = ?4 AND status = 'running'",
            )
            .bind(&[
                db::i(permanent as i64),
                db::s(&error_message),
                db::i(util::now_ms()),
                db::s(action_id),
            ])?
            .run()
            .await?;
            Err(error)
        }
    }
}

async fn cancel_action_if_stale(db: &D1Database, action_id: &str, now: i64) -> Result<bool> {
    let result = db
        .prepare(
            "UPDATE policy_actions SET status = 'cancelled', updated_at = ?1 \
             WHERE id = ?2 AND status = 'pending' \
               AND NOT EXISTS (SELECT 1 FROM policy_instances pi \
                 JOIN policy_rules pr ON pr.id = pi.rule_id \
                 JOIN policy_sets ps ON ps.id = pr.policy_set_id \
                 WHERE pi.id = policy_actions.instance_id AND pi.active = 1 \
                   AND pi.rule_version = pr.version AND pr.enabled = 1 \
                   AND ps.id = COALESCE( \
                     (SELECT room.id FROM policy_sets room \
                      WHERE room.person_id = ps.person_id AND room.scope = 'room' \
                        AND room.activity_id = pi.activity_id LIMIT 1), \
                     (SELECT home.id FROM policy_sets home \
                      WHERE home.person_id = ps.person_id AND home.scope = 'home' LIMIT 1)))",
        )
        .bind(&[db::i(now), db::s(action_id)])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) != 0)
}

async fn earlier_action_blocker(
    db: &D1Database,
    row: &ActionExecutionRow,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct StatusRow {
        status: String,
    }
    Ok(db
        .prepare(
            "SELECT status FROM policy_actions \
             WHERE instance_id = ?1 AND occurrence = ?2 AND sequence_index < ?3 \
               AND status IN ('pending', 'running', 'failed') \
             ORDER BY sequence_index LIMIT 1",
        )
        .bind(&[
            db::s(&row.instance_id),
            db::i(row.occurrence),
            db::i(row.sequence_index),
        ])?
        .first::<StatusRow>(None)
        .await?
        .map(|row| row.status))
}

async fn action_owner_is_eligible(
    db: &D1Database,
    row: &ActionExecutionRow,
    now: i64,
) -> Result<bool> {
    #[derive(Deserialize)]
    struct EligibleRow {
        eligible: i64,
    }
    let result = db
        .prepare(
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM participations \
                       WHERE run_id = ?1 AND person_id = ?2) \
                    OR EXISTS (SELECT 1 FROM policy_actions pa \
                       JOIN policy_instances pi ON pi.id = pa.instance_id \
                       JOIN policy_rules pr ON pr.id = pi.rule_id \
                       JOIN policy_sets ps ON ps.id = pr.policy_set_id \
                       JOIN room_presence rp ON rp.activity_id = pi.activity_id \
                         AND rp.person_id = ps.person_id \
                       WHERE pa.id = ?3 AND rp.last_seen_at >= ?4) \
                   THEN 1 ELSE 0 END AS eligible",
        )
        .bind(&[
            db::s(&row.run_id),
            db::s(&row.person_id),
            db::s(&row.id),
            db::i(now - crate::api::DESPONDENT_MS),
        ])?
        .first::<EligibleRow>(None)
        .await?;
    Ok(result.is_some_and(|result| result.eligible != 0))
}

async fn load_action(db: &D1Database, action_id: &str) -> Result<Option<ActionExecutionRow>> {
    db.prepare(
        "SELECT pa.id, pa.instance_id, pa.status, pa.due_at, pa.payload_json, pa.occurrence, \
                pa.action_key, pa.sequence_index, \
                ps.person_id, pi.activity_id, pi.run_id, a.title AS activity_title, \
                a.code AS activity_code, a.max_commit_seconds, pa.causal_depth \
         FROM policy_actions pa \
         JOIN policy_instances pi ON pi.id = pa.instance_id \
         JOIN policy_rules pr ON pr.id = pi.rule_id \
         JOIN policy_sets ps ON ps.id = pr.policy_set_id \
         JOIN activities a ON a.id = pi.activity_id \
         WHERE pa.id = ?1",
    )
    .bind(&[db::s(action_id)])?
    .first::<ActionExecutionRow>(None)
    .await
}

async fn create_policy_notification(
    env: &Env,
    db: &D1Database,
    row: &ActionExecutionRow,
    message: &str,
) -> Result<()> {
    let now = util::now_ms();
    let notification_id = util::new_id();
    let dedupe = format!("policy:{}:{}:{}", row.id, row.occurrence, row.action_key);
    let title = row.activity_title.clone();
    let url = format!("/{}", row.activity_code);
    db.prepare(
        "INSERT OR IGNORE INTO notifications \
           (id, recipient_id, activity_id, run_id, kind, message, read_at, created_at, \
            title, url, dedupe_key) \
         VALUES (?1, ?2, ?3, ?4, 'policy', ?5, NULL, ?6, ?7, ?8, ?9)",
    )
    .bind(&[
        db::s(&notification_id),
        db::s(&row.person_id),
        db::s(&row.activity_id),
        db::s(&row.run_id),
        db::s(message),
        db::i(now),
        db::s(&title),
        db::s(&url),
        db::s(&dedupe),
    ])?
    .run()
    .await?;
    #[derive(Deserialize)]
    struct NotificationId {
        id: String,
    }
    let notification = db
        .prepare("SELECT id FROM notifications WHERE recipient_id = ?1 AND dedupe_key = ?2")
        .bind(&[db::s(&row.person_id), db::s(&dedupe)])?
        .first::<NotificationId>(None)
        .await?
        .ok_or_else(|| Error::RustError("policy notification insert failed".to_string()))?;
    db.prepare(
        "INSERT OR IGNORE INTO push_deliveries \
           (id, notification_id, subscription_id, status, next_attempt_at, created_at, updated_at) \
         SELECT lower(hex(randomblob(16))), ?1, id, 'pending', ?2, ?2, ?2 \
         FROM push_subscriptions \
         WHERE person_id = ?3 AND disabled_at IS NULL \
           AND (expiration_time IS NULL OR expiration_time > ?2)",
    )
    .bind(&[db::s(&notification.id), db::i(now), db::s(&row.person_id)])?
    .run()
    .await?;
    enqueue_notification_deliveries(env, db, &notification.id, now).await
}

pub async fn queue_test_push(
    env: &Env,
    db: &D1Database,
    person_id: &str,
) -> Result<PushTestQueued> {
    let now = util::now_ms();
    let notification_id = util::new_id();
    let dedupe = format!("push-test:{notification_id}");
    db.prepare(
        "INSERT INTO notifications \
           (id, recipient_id, kind, message, read_at, created_at, title, url, dedupe_key) \
         VALUES (?1, ?2, 'push_test', 'Web Push reached this browser.', NULL, ?3, \
                 'fold notification test', '/', ?4)",
    )
    .bind(&[
        db::s(&notification_id),
        db::s(person_id),
        db::i(now),
        db::s(&dedupe),
    ])?
    .run()
    .await?;
    let inserted = db
        .prepare(
            "INSERT OR IGNORE INTO push_deliveries \
               (id, notification_id, subscription_id, status, next_attempt_at, created_at, updated_at) \
             SELECT lower(hex(randomblob(16))), ?1, id, 'pending', ?2, ?2, ?2 \
             FROM push_subscriptions \
             WHERE person_id = ?3 AND disabled_at IS NULL \
               AND (expiration_time IS NULL OR expiration_time > ?2)",
        )
        .bind(&[db::s(&notification_id), db::i(now), db::s(person_id)])?
        .run()
        .await?;
    let deliveries_queued = inserted.meta()?.and_then(|meta| meta.changes).unwrap_or(0) as i64;
    enqueue_notification_deliveries(env, db, &notification_id, now).await?;
    console_log!(
        "[fold:push] test_queued notification={} deliveries={}",
        notification_id,
        deliveries_queued
    );
    Ok(PushTestQueued {
        notification_id,
        deliveries_queued,
    })
}

async fn enqueue_notification_deliveries(
    env: &Env,
    db: &D1Database,
    notification_id: &str,
    now: i64,
) -> Result<()> {
    let rows = db
        .prepare(
            "SELECT id FROM push_deliveries WHERE notification_id = ?1 \
             AND status IN ('pending', 'retry') AND next_attempt_at <= ?2 \
             AND (queued_at IS NULL OR queued_at < ?3)",
        )
        .bind(&[
            db::s(notification_id),
            db::i(now + i64::from(MAX_QUEUE_DELAY_SECONDS) * 1000),
            db::i(now - STALE_JOB_MS),
        ])?
        .all()
        .await?
        .results::<DueIdRow>()?;
    for row in rows {
        enqueue(
            env,
            PolicyJob::Push {
                delivery_id: row.id.clone(),
            },
            0,
        )
        .await?;
        db.prepare("UPDATE push_deliveries SET queued_at = ?1 WHERE id = ?2")
            .bind(&[db::i(now), db::s(&row.id)])?
            .run()
            .await?;
    }
    Ok(())
}

async fn apply_state_action(
    env: &Env,
    db: &D1Database,
    row: &ActionExecutionRow,
    state: &str,
    eta_delta_secs: Option<i64>,
) -> Result<()> {
    let now = util::now_ms();
    let activity = db::get_activity(db, &row.activity_id)
        .await?
        .ok_or_else(|| Error::RustError("policy activity no longer exists".to_string()))?;
    let run = db::get_run(db, &row.run_id)
        .await?
        .ok_or_else(|| Error::RustError("policy run no longer exists".to_string()))?;
    if run.activity_id != activity.id || activity.current_run_id.as_deref() != Some(&run.id) {
        return Err(Error::RustError(
            "policy state action targeted an inactive run".to_string(),
        ));
    }
    let run = crate::api::refresh_run(db, &run.id, &activity, now)
        .await?
        .0;
    let current = db
        .prepare(
            "SELECT state, arrival_at FROM participations WHERE run_id = ?1 AND person_id = ?2",
        )
        .bind(&[db::s(&row.run_id), db::s(&row.person_id)])?
        .first::<CurrentParticipationRow>(None)
        .await?;
    let mutation = match state {
        "lurker" => db
            .prepare("DELETE FROM participations WHERE run_id = ?1 AND person_id = ?2")
            .bind(&[db::s(&row.run_id), db::s(&row.person_id)])?,
        "interested" => {
            if !matches!(run.status.as_str(), "open" | "ready" | "scheduled") {
                return Err(Error::RustError(
                    "policy cannot express interest in this run".to_string(),
                ));
            }
            participation_upsert(db, &row.run_id, &row.person_id, "interested", None, now)?
        }
        "committed" => {
            if !matches!(run.status.as_str(), "open" | "ready") {
                return Err(Error::RustError(
                    "policy cannot commit to this run".to_string(),
                ));
            }
            let already_committed = current
                .as_ref()
                .is_some_and(|current| current.state == "committed");
            if !already_committed {
                if db::other_committed_run(db, &row.person_id, &row.run_id)
                    .await?
                    .is_some()
                {
                    return Err(Error::RustError(
                        "policy owner is committed to another activity".to_string(),
                    ));
                }
                if activity
                    .max_people
                    .is_some_and(|maximum| run.committed_count + 1 > maximum)
                {
                    return Err(Error::RustError("policy activity is full".to_string()));
                }
            }
            let max_eta = row.max_commit_seconds.max(0);
            let default_eta = max_eta.min(30 * 60);
            let eta = match eta_delta_secs {
                None => default_eta,
                Some(delta) => {
                    let current_eta = current
                        .filter(|current| current.state == "committed")
                        .and_then(|current| current.arrival_at)
                        .map(|arrival| ((arrival - now + 999) / 1000).max(0))
                        .unwrap_or(default_eta);
                    current_eta.saturating_add(delta).clamp(0, max_eta)
                }
            };
            participation_upsert(
                db,
                &row.run_id,
                &row.person_id,
                "committed",
                Some(now.saturating_add(eta.saturating_mul(1000))),
                now,
            )?
        }
        other => return Err(Error::RustError(format!("unknown policy state '{other}'"))),
    };
    let mut statements = vec![
        mutation,
        db.prepare("UPDATE people SET last_seen_at = ?1 WHERE id = ?2")
            .bind(&[db::i(now), db::s(&row.person_id)])?,
        db.prepare("UPDATE activities SET last_active_at = ?1, updated_at = ?1 WHERE id = ?2")
            .bind(&[db::i(now), db::s(&row.activity_id)])?,
        db.prepare(
            "UPDATE policy_actions SET status = 'completed', last_error = NULL, updated_at = ?1 \
             WHERE id = ?2 AND status = 'running'",
        )
        .bind(&[db::i(now), db::s(&row.id)])?,
    ];
    let next_depth = row.causal_depth.saturating_add(1);
    let event_id = (next_depth <= MAX_CAUSAL_DEPTH).then(util::new_id);
    if let Some(event_id) = &event_id {
        statements.push(
            db.prepare(
                "INSERT INTO domain_events \
                   (id, activity_id, run_id, kind, actor_id, causal_depth, occurred_at) \
                 VALUES (?1, ?2, ?3, 'policy_state_changed', ?4, ?5, ?6)",
            )
            .bind(&[
                db::s(event_id),
                db::s(&row.activity_id),
                db::s(&row.run_id),
                db::s(&row.person_id),
                db::i(next_depth),
                db::i(now),
            ])?,
        );
    }
    db.batch(statements).await?;
    if let Err(error) = crate::api::refresh_run(db, &row.run_id, &activity, now).await {
        console_error!("could not refresh run after policy state action: {error}");
    }
    if let Some(event_id) = event_id {
        publish_event(env, db, &event_id, now).await?;
    }
    Ok(())
}

fn participation_upsert(
    db: &D1Database,
    run_id: &str,
    person_id: &str,
    state: &str,
    arrival_at: Option<i64>,
    now: i64,
) -> Result<worker::D1PreparedStatement> {
    db.prepare(
        "INSERT INTO participations \
           (id, run_id, person_id, state, arrival_at, created_at, updated_at, state_changed_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6) \
         ON CONFLICT(run_id, person_id) DO UPDATE SET \
           state_changed_at = CASE WHEN participations.state != excluded.state \
                                   THEN excluded.updated_at ELSE participations.state_changed_at END, \
           state = excluded.state, arrival_at = excluded.arrival_at, updated_at = excluded.updated_at",
    )
    .bind(&[
        db::s(&util::new_id()),
        db::s(run_id),
        db::s(person_id),
        db::s(state),
        db::oi(arrival_at),
        db::i(now),
    ])
}

async fn process_delivery(env: &Env, db: &D1Database, delivery_id: &str) -> Result<()> {
    let now = util::now_ms();
    let Some(row) = db
        .prepare(
            "SELECT pd.id, pd.notification_id, pd.subscription_id, pd.attempts, \
                    n.title, n.message, n.url, n.dedupe_key, n.created_at, \
                    ps.endpoint, ps.p256dh, ps.auth \
             FROM push_deliveries pd \
             JOIN notifications n ON n.id = pd.notification_id \
             JOIN push_subscriptions ps ON ps.id = pd.subscription_id \
             WHERE pd.id = ?1 AND pd.status IN ('pending', 'retry') AND pd.next_attempt_at <= ?2",
        )
        .bind(&[db::s(delivery_id), db::i(now)])?
        .first::<DeliveryRow>(None)
        .await?
    else {
        return Ok(());
    };
    let claimed = db
        .prepare(
            "UPDATE push_deliveries SET status = 'sending', attempts = attempts + 1, updated_at = ?1 \
             WHERE id = ?2 AND status IN ('pending', 'retry') AND next_attempt_at <= ?1",
        )
        .bind(&[db::i(now), db::s(delivery_id)])?
        .run()
        .await?;
    if claimed.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 0 {
        return Ok(());
    }
    let subscription = db::PushSubscriptionRow {
        id: row.subscription_id.clone(),
        endpoint: row.endpoint.clone(),
        p256dh: row.p256dh.clone(),
        auth: row.auth.clone(),
    };
    let title = row.title.as_deref().unwrap_or("fold");
    let url = row.url.as_deref().unwrap_or("/");
    let tag = row.dedupe_key.as_deref().unwrap_or(&row.notification_id);
    let payload = push::PushPayload {
        id: &row.notification_id,
        title,
        body: &row.message,
        url,
        tag,
        created_at: row.created_at,
    };
    match push::send_payload_to_subscription(env, &subscription, &payload).await {
        Ok(Some(response)) if (200..300).contains(&response.status) => {
            db.prepare(
                "UPDATE push_deliveries SET status = 'delivered', last_status = ?1, \
                   last_error = NULL, updated_at = ?2 WHERE id = ?3",
            )
            .bind(&[
                db::i(i64::from(response.status)),
                db::i(now),
                db::s(delivery_id),
            ])?
            .run()
            .await?;
            db.prepare(
                "UPDATE push_subscriptions SET last_success_at = ?1, failure_count = 0 WHERE id = ?2",
            )
            .bind(&[db::i(now), db::s(&row.subscription_id)])?
            .run()
            .await?;
            console_log!(
                "[fold:push] delivery_delivered delivery={} notification={} status={}",
                delivery_id,
                row.notification_id,
                response.status
            );
        }
        Ok(Some(response)) if matches!(response.status, 404 | 410) => {
            let error = response
                .details
                .as_deref()
                .unwrap_or("subscription expired");
            mark_delivery_failed(db, delivery_id, Some(response.status), error, now).await?;
            db.prepare("UPDATE push_subscriptions SET disabled_at = ?1 WHERE id = ?2")
                .bind(&[db::i(now), db::s(&row.subscription_id)])?
                .run()
                .await?;
        }
        Ok(Some(response)) if response.status == 429 || response.status >= 500 => {
            let error = response
                .details
                .as_deref()
                .unwrap_or("push service unavailable");
            retry_delivery(env, db, &row, Some(response.status), error, now).await?;
        }
        Ok(Some(response)) => {
            let error = response
                .details
                .as_deref()
                .unwrap_or("push service rejected request");
            mark_delivery_failed(db, delivery_id, Some(response.status), error, now).await?;
            console_log!(
                "[fold:push] delivery_failed delivery={} notification={} status={} details={}",
                delivery_id,
                row.notification_id,
                response.status,
                error
            );
        }
        Ok(None) => {
            retry_delivery(env, db, &row, None, "VAPID is not configured", now).await?;
        }
        Err(error) => {
            retry_delivery(env, db, &row, None, &error.to_string(), now).await?;
        }
    }
    Ok(())
}

async fn retry_delivery(
    env: &Env,
    db: &D1Database,
    row: &DeliveryRow,
    status: Option<u16>,
    error: &str,
    now: i64,
) -> Result<()> {
    let attempts = row.attempts + 1;
    if attempts >= 10 {
        return mark_delivery_failed(db, &row.id, status, error, now).await;
    }
    let delay_seconds = 30_i64
        .saturating_mul(1_i64 << attempts.min(10) as u32)
        .min(3600);
    let next = now.saturating_add(delay_seconds * 1000);
    db.prepare(
        "UPDATE push_deliveries SET status = 'retry', next_attempt_at = ?1, queued_at = NULL, \
           last_status = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?5",
    )
    .bind(&[
        db::i(next),
        db::oi(status.map(i64::from)),
        db::s(error),
        db::i(now),
        db::s(&row.id),
    ])?
    .run()
    .await?;
    enqueue(
        env,
        PolicyJob::Push {
            delivery_id: row.id.clone(),
        },
        next - now,
    )
    .await?;
    db.prepare("UPDATE push_deliveries SET queued_at = ?1 WHERE id = ?2")
        .bind(&[db::i(now), db::s(&row.id)])?
        .run()
        .await?;
    Ok(())
}

async fn mark_delivery_failed(
    db: &D1Database,
    delivery_id: &str,
    status: Option<u16>,
    error: &str,
    now: i64,
) -> Result<()> {
    db.prepare(
        "UPDATE push_deliveries SET status = 'failed', last_status = ?1, last_error = ?2, \
           updated_at = ?3 WHERE id = ?4",
    )
    .bind(&[
        db::oi(status.map(i64::from)),
        db::s(error),
        db::i(now),
        db::s(delivery_id),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn sweep(env: &Env) -> Result<()> {
    let db = env.d1("DB")?;
    let now = util::now_ms();
    db.prepare(
        "UPDATE policy_actions SET status = 'pending', queued_at = NULL, updated_at = ?1 \
         WHERE status = 'running' AND updated_at < ?2",
    )
    .bind(&[db::i(now), db::i(now - STALE_JOB_MS)])?
    .run()
    .await?;
    db.prepare(
        "UPDATE push_deliveries SET status = 'retry', queued_at = NULL, next_attempt_at = ?1, updated_at = ?1 \
         WHERE status = 'sending' AND updated_at < ?2",
    )
    .bind(&[db::i(now), db::i(now - STALE_JOB_MS)])?
    .run()
    .await?;

    let events = db
        .prepare(
            "SELECT id FROM domain_events WHERE processed_at IS NULL ORDER BY occurred_at LIMIT 20",
        )
        .all()
        .await?
        .results::<DueIdRow>()?;
    for event in events {
        process_event(env, &db, &event.id).await?;
    }

    let due_evaluations = db
        .prepare(
            "SELECT DISTINCT activity_id, run_id FROM policy_instances \
             WHERE next_evaluate_at IS NOT NULL AND next_evaluate_at <= ?1 LIMIT 20",
        )
        .bind(&[db::i(now)])?
        .all()
        .await?
        .results::<DueEvaluationRow>()?;
    for due in due_evaluations {
        evaluate_activity(env, &db, &due.activity_id, &due.run_id, 0).await?;
    }

    // Recovery does not depend on the outbox: rotate through active policy
    // contexts so a failed event insert/publication is eventually repaired.
    let recovery = db
        .prepare(
            "SELECT a.id AS activity_id, a.current_run_id AS run_id \
             FROM activities a \
             JOIN runs r ON r.id = a.current_run_id \
             LEFT JOIN policy_instances pi \
               ON pi.activity_id = a.id AND pi.run_id = a.current_run_id \
             WHERE a.current_run_id IS NOT NULL \
               AND EXISTS (SELECT 1 FROM policy_sets ps \
                 JOIN policy_rules pr ON pr.policy_set_id = ps.id AND pr.enabled = 1 \
                 WHERE (ps.scope = 'room' AND ps.activity_id = a.id \
                    OR ps.scope = 'home' AND NOT EXISTS (SELECT 1 FROM policy_sets room \
                       WHERE room.person_id = ps.person_id AND room.scope = 'room' \
                         AND room.activity_id = a.id)) \
                   AND (EXISTS (SELECT 1 FROM participations p \
                          WHERE p.run_id = a.current_run_id AND p.person_id = ps.person_id) \
                     OR EXISTS (SELECT 1 FROM room_presence rp \
                          WHERE rp.activity_id = a.id AND rp.person_id = ps.person_id \
                            AND rp.last_seen_at >= ?1))) \
             GROUP BY a.id, a.current_run_id \
             ORDER BY COALESCE(MAX(pi.last_evaluated_at), 0) ASC \
             LIMIT 5",
        )
        .bind(&[db::i(now - crate::api::DESPONDENT_MS)])?
        .all()
        .await?
        .results::<DueEvaluationRow>()?;
    for context in recovery {
        evaluate_activity(env, &db, &context.activity_id, &context.run_id, 0).await?;
    }

    let actions = db
        .prepare(
            "SELECT id FROM policy_actions WHERE status = 'pending' AND due_at <= ?1 \
             ORDER BY due_at LIMIT 20",
        )
        .bind(&[db::i(now)])?
        .all()
        .await?
        .results::<DueIdRow>()?;
    for action in actions {
        process_action(env, &db, &action.id).await?;
    }

    let deliveries = db
        .prepare(
            "SELECT id FROM push_deliveries WHERE status IN ('pending', 'retry') \
             AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT 20",
        )
        .bind(&[db::i(now)])?
        .all()
        .await?
        .results::<DueIdRow>()?;
    for delivery in deliveries {
        process_delivery(env, &db, &delivery.id).await?;
    }
    Ok(())
}
