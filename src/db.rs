//! D1 query helpers.
//!
//! Counters on `runs` are kept authoritative by recomputing them from
//! `participations` on each mutation (`recompute_run_counts`). Lifetime stats
//! on `activities` (times_run, players_served, interest_total, commit_total)
//! are incremented once, at run-end, from that run's final denormalized
//! counts -- no extra scans needed since a participation's state is
//! exclusive (interested XOR committed).

use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::models::{
    ActivityRow, NotificationRow, ParticipantView, ParticipationLite, PersonRow, RunRow,
};

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PushSubscriptionRow {
    pub endpoint: String,
}

// ---- bind value helpers ----------------------------------------------------

pub fn s(v: &str) -> JsValue {
    JsValue::from_str(v)
}
pub fn os(v: Option<&str>) -> JsValue {
    match v {
        Some(x) => JsValue::from_str(x),
        None => JsValue::NULL,
    }
}
pub fn i(v: i64) -> JsValue {
    JsValue::from_f64(v as f64)
}
pub fn oi(v: Option<i64>) -> JsValue {
    match v {
        Some(x) => JsValue::from_f64(x as f64),
        None => JsValue::NULL,
    }
}

const ACTIVITY_COLS: &str = "a.id, a.code, a.emoji, a.title, a.description, a.category, \
    a.proposer_id, a.min_people, a.max_people, a.group_multiple, a.grouping_mode, \
    a.allow_guests, a.private_by_link, a.duration_minutes, a.max_commit_minutes, \
    a.current_run_id, a.times_run, a.players_served, a.interest_total, a.commit_total, \
    a.last_active_at, a.created_at, a.updated_at, p.handle AS proposer_handle";

const RUN_COLS: &str = "id, activity_id, status, location, details, scheduled_for, expires_at, \
    interested_count, committed_count, reached_ready, created_at, updated_at, ended_at";

// ---- people ----------------------------------------------------------------

pub async fn get_person(db: &D1Database, id: &str) -> Result<Option<PersonRow>> {
    db.prepare("SELECT id, handle, color, created_at, last_seen_at FROM people WHERE id = ?")
        .bind(&[s(id)])?
        .first::<PersonRow>(None)
        .await
}

pub async fn touch_person(db: &D1Database, id: &str, now: i64) -> Result<()> {
    db.prepare("UPDATE people SET last_seen_at = ? WHERE id = ?")
        .bind(&[i(now), s(id)])?
        .run()
        .await?;
    Ok(())
}

// ---- push subscriptions -----------------------------------------------------

pub async fn upsert_push_subscription(
    db: &D1Database,
    person_id: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    now: i64,
) -> Result<()> {
    let id = crate::util::new_id();
    db.prepare(
        "INSERT INTO push_subscriptions (id, person_id, endpoint, p256dh, auth, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(person_id, endpoint) DO UPDATE SET p256dh = ?4, auth = ?5",
    )
    .bind(&[
        s(&id),
        s(person_id),
        s(endpoint),
        s(p256dh),
        s(auth),
        i(now),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_push_subscription(
    db: &D1Database,
    person_id: &str,
    endpoint: &str,
) -> Result<()> {
    db.prepare("DELETE FROM push_subscriptions WHERE person_id = ? AND endpoint = ?")
        .bind(&[s(person_id), s(endpoint)])?
        .run()
        .await?;
    Ok(())
}

pub async fn delete_push_endpoint(db: &D1Database, endpoint: &str) -> Result<()> {
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
        .bind(&[s(endpoint)])?
        .run()
        .await?;
    Ok(())
}

pub async fn push_subscriptions_for_people(
    db: &D1Database,
    person_ids: &[String],
    limit: i64,
) -> Result<Vec<PushSubscriptionRow>> {
    if person_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(person_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT endpoint \
         FROM push_subscriptions WHERE person_id IN ({placeholders}) LIMIT ?"
    );
    let mut values = Vec::new();
    for id in person_ids {
        values.push(s(id));
    }
    values.push(i(limit));
    db.prepare(&sql)
        .bind(&values)?
        .all()
        .await?
        .results::<PushSubscriptionRow>()
}

/// Person ids currently committed to a run (optionally excluding one person).
pub async fn committed_person_ids(
    db: &D1Database,
    run_id: &str,
    exclude_person: Option<&str>,
) -> Result<Vec<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        person_id: String,
    }
    let recipients = db
        .prepare("SELECT person_id FROM participations WHERE run_id = ? AND state = 'committed'")
        .bind(&[s(run_id)])?
        .all()
        .await?
        .results::<Row>()?;
    Ok(recipients
        .into_iter()
        .map(|r| r.person_id)
        .filter(|id| Some(id.as_str()) != exclude_person)
        .collect())
}

// ---- activities (templates/tiles) ------------------------------------------

/// Activities active within the last `window_ms` (the homepage's 7-day
/// visibility window). Ordered most-recently-active first.
pub async fn list_activities(db: &D1Database, since: i64, limit: i64) -> Result<Vec<ActivityRow>> {
    let sql = format!(
        "SELECT {ACTIVITY_COLS} FROM activities a \
         LEFT JOIN people p ON p.id = a.proposer_id \
         WHERE a.last_active_at >= ?1 AND a.private_by_link = 0 \
         ORDER BY a.last_active_at DESC LIMIT ?2"
    );
    db.prepare(&sql)
        .bind(&[i(since), i(limit)])?
        .all()
        .await?
        .results::<ActivityRow>()
}

pub async fn get_activity(db: &D1Database, id: &str) -> Result<Option<ActivityRow>> {
    let sql = format!(
        "SELECT {ACTIVITY_COLS} FROM activities a \
         LEFT JOIN people p ON p.id = a.proposer_id WHERE a.id = ?"
    );
    db.prepare(&sql)
        .bind(&[s(id)])?
        .first::<ActivityRow>(None)
        .await
}

pub async fn get_activity_by_code(db: &D1Database, code: &str) -> Result<Option<ActivityRow>> {
    let sql = format!(
        "SELECT {ACTIVITY_COLS} FROM activities a \
         LEFT JOIN people p ON p.id = a.proposer_id WHERE UPPER(a.code) = ?"
    );
    db.prepare(&sql)
        .bind(&[s(&code.to_ascii_uppercase())])?
        .first::<ActivityRow>(None)
        .await
}

/// Case-insensitive title lookup, used to reject duplicate activities.
pub async fn get_activity_by_title(db: &D1Database, title: &str) -> Result<Option<ActivityRow>> {
    let sql = format!(
        "SELECT {ACTIVITY_COLS} FROM activities a \
         LEFT JOIN people p ON p.id = a.proposer_id WHERE LOWER(a.title) = LOWER(?)"
    );
    db.prepare(&sql)
        .bind(&[s(title)])?
        .first::<ActivityRow>(None)
        .await
}

/// Bump `last_active_at` (and `updated_at`) -- resets the 7-day homepage
/// visibility window. Called on run creation and on any interest/commit.
pub async fn touch_activity_last_active(
    db: &D1Database,
    activity_id: &str,
    now: i64,
) -> Result<()> {
    db.prepare("UPDATE activities SET last_active_at = ?, updated_at = ? WHERE id = ?")
        .bind(&[i(now), i(now), s(activity_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn set_activity_current_run(
    db: &D1Database,
    activity_id: &str,
    run_id: Option<&str>,
    now: i64,
) -> Result<()> {
    db.prepare("UPDATE activities SET current_run_id = ?, updated_at = ? WHERE id = ?")
        .bind(&[os(run_id), i(now), s(activity_id)])?
        .run()
        .await?;
    Ok(())
}

/// Roll a just-ended run's final counts onto the activity's lifetime stats.
/// `times_run_inc` should be 1 only if the run ever reached a complete group.
pub async fn rollup_activity_stats(
    db: &D1Database,
    activity_id: &str,
    times_run_inc: i64,
    players_served_inc: i64,
    interest_inc: i64,
    commit_inc: i64,
    now: i64,
) -> Result<()> {
    db.prepare(
        "UPDATE activities SET \
            times_run = times_run + ?1, \
            players_served = players_served + ?2, \
            interest_total = interest_total + ?3, \
            commit_total = commit_total + ?4, \
            updated_at = ?5 \
         WHERE id = ?6",
    )
    .bind(&[
        i(times_run_inc),
        i(players_served_inc),
        i(interest_inc),
        i(commit_inc),
        i(now),
        s(activity_id),
    ])?
    .run()
    .await?;
    Ok(())
}

// ---- runs -------------------------------------------------------------------

pub async fn insert_run(
    db: &D1Database,
    id: &str,
    activity_id: &str,
    location: Option<&str>,
    details: Option<&str>,
    scheduled_for: Option<i64>,
    expires_at: Option<i64>,
    now: i64,
) -> Result<()> {
    db.prepare(
        "INSERT INTO runs \
         (id, activity_id, status, location, details, scheduled_for, expires_at, \
           interested_count, committed_count, reached_ready, created_at, updated_at) \
         VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6, 0, 0, 0, ?7, ?7)",
    )
    .bind(&[
        s(id),
        s(activity_id),
        os(location),
        os(details),
        oi(scheduled_for),
        oi(expires_at),
        i(now),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn get_run(db: &D1Database, id: &str) -> Result<Option<RunRow>> {
    let sql = format!("SELECT {RUN_COLS} FROM runs WHERE id = ?");
    db.prepare(&sql).bind(&[s(id)])?.first::<RunRow>(None).await
}

/// Batch-fetch runs by id (used to attach each activity's current run in
/// list views without an N+1 query).
pub async fn get_runs_by_ids(db: &D1Database, ids: &[String]) -> Result<Vec<RunRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT {RUN_COLS} FROM runs WHERE id IN ({placeholders})");
    let values: Vec<JsValue> = ids.iter().map(|id| s(id)).collect();
    db.prepare(&sql)
        .bind(&values)?
        .all()
        .await?
        .results::<RunRow>()
}

/// Recompute denormalized counts from participations and refresh `updated_at`.
pub async fn recompute_run_counts(db: &D1Database, run_id: &str, now: i64) -> Result<()> {
    db.prepare(
        "UPDATE runs SET \
            interested_count = (SELECT COUNT(*) FROM participations WHERE run_id = ?1 AND state = 'interested'), \
            committed_count  = (SELECT COUNT(*) FROM participations WHERE run_id = ?1 AND state = 'committed'), \
            updated_at = ?2 \
         WHERE id = ?1",
    )
    .bind(&[s(run_id), i(now)])?
    .run()
    .await?;
    Ok(())
}

pub async fn set_run_status(db: &D1Database, run_id: &str, status: &str, now: i64) -> Result<()> {
    let ended = matches!(status, "closed" | "cancelled");
    if ended {
        db.prepare("UPDATE runs SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?")
            .bind(&[s(status), i(now), i(now), s(run_id)])?
            .run()
            .await?;
    } else {
        db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
            .bind(&[s(status), i(now), s(run_id)])?
            .run()
            .await?;
    }
    Ok(())
}

pub async fn set_run_schedule(
    db: &D1Database,
    run_id: &str,
    status: &str,
    scheduled_for: i64,
    location: Option<&str>,
    now: i64,
) -> Result<()> {
    db.prepare(
        "UPDATE runs SET status = ?, scheduled_for = ?, location = COALESCE(?, location), updated_at = ? WHERE id = ?",
    )
    .bind(&[s(status), i(scheduled_for), os(location), i(now), s(run_id)])?
    .run()
    .await?;
    Ok(())
}

/// Mark a run as having reached at least one complete group. Sticky: never
/// reset back to false even if people later withdraw.
pub async fn mark_run_reached_ready(db: &D1Database, run_id: &str) -> Result<()> {
    db.prepare("UPDATE runs SET reached_ready = 1 WHERE id = ?")
        .bind(&[s(run_id)])?
        .run()
        .await?;
    Ok(())
}

// ---- participations ---------------------------------------------------------

pub async fn participations_for_person(
    db: &D1Database,
    person_id: &str,
) -> Result<Vec<ParticipationLite>> {
    db.prepare("SELECT run_id, state FROM participations WHERE person_id = ?")
        .bind(&[s(person_id)])?
        .all()
        .await?
        .results::<ParticipationLite>()
}

pub async fn participation_state(
    db: &D1Database,
    run_id: &str,
    person_id: &str,
) -> Result<Option<String>> {
    let row = db
        .prepare("SELECT run_id, state FROM participations WHERE run_id = ? AND person_id = ?")
        .bind(&[s(run_id), s(person_id)])?
        .first::<ParticipationLite>(None)
        .await?;
    Ok(row.map(|r| r.state))
}

/// The other run (and its activity) a person is currently committed to, if
/// any. Commit is exclusive globally: at most one committed run per person.
pub struct OtherCommitment {
    pub run_id: String,
    pub activity_id: String,
    pub activity_code: String,
    pub activity_title: String,
}

pub async fn other_committed_run(
    db: &D1Database,
    person_id: &str,
    exclude_run_id: &str,
) -> Result<Option<OtherCommitment>> {
    #[derive(serde::Deserialize)]
    struct Row {
        run_id: String,
        activity_id: String,
        activity_code: String,
        activity_title: String,
    }
    let row = db
        .prepare(
            "SELECT part.run_id AS run_id, r.activity_id AS activity_id, \
                    a.code AS activity_code, a.title AS activity_title \
             FROM participations part \
             JOIN runs r ON r.id = part.run_id \
             JOIN activities a ON a.id = r.activity_id \
             WHERE part.person_id = ? AND part.state = 'committed' AND part.run_id != ? LIMIT 1",
        )
        .bind(&[s(person_id), s(exclude_run_id)])?
        .first::<Row>(None)
        .await?;
    Ok(row.map(|r| OtherCommitment {
        run_id: r.run_id,
        activity_id: r.activity_id,
        activity_code: r.activity_code,
        activity_title: r.activity_title,
    }))
}

pub async fn upsert_participation(
    db: &D1Database,
    run_id: &str,
    person_id: &str,
    state: &str,
    arrival_at: Option<i64>,
    now: i64,
) -> Result<()> {
    let id = crate::util::new_id();
    db.prepare(
        "INSERT INTO participations (id, run_id, person_id, state, arrival_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
         ON CONFLICT(run_id, person_id) DO UPDATE SET state = ?4, arrival_at = ?5, updated_at = ?6",
    )
    .bind(&[
        s(&id),
        s(run_id),
        s(person_id),
        s(state),
        oi(arrival_at),
        i(now),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn participants_for_run(
    db: &D1Database,
    run_id: &str,
    me_id: Option<&str>,
) -> Result<Vec<ParticipantView>> {
    #[derive(serde::Deserialize)]
    struct Row {
        id: String,
        person_id: String,
        color: String,
        state: String,
        arrival_at: Option<i64>,
    }
    let rows = db
        .prepare(
            "SELECT part.id, part.person_id, p.color, part.state, part.arrival_at \
             FROM participations part \
             JOIN people p ON p.id = part.person_id \
             WHERE part.run_id = ? \
             ORDER BY part.updated_at ASC",
        )
        .bind(&[s(run_id)])?
        .all()
        .await?
        .results::<Row>()?;
    Ok(rows
        .into_iter()
        .map(|r| ParticipantView {
            id: r.id,
            color: r.color,
            state: r.state,
            arrival_at: r.arrival_at,
            is_me: Some(r.person_id.as_str()) == me_id,
        })
        .collect())
}

pub async fn delete_participation(db: &D1Database, run_id: &str, person_id: &str) -> Result<()> {
    db.prepare("DELETE FROM participations WHERE run_id = ? AND person_id = ?")
        .bind(&[s(run_id), s(person_id)])?
        .run()
        .await?;
    Ok(())
}

// ---- notifications ---------------------------------------------------------

pub async fn unread_notifications(
    db: &D1Database,
    person_id: &str,
    limit: i64,
) -> Result<Vec<NotificationRow>> {
    db.prepare(
        "SELECT id, recipient_id, activity_id, run_id, kind, message, read_at, created_at \
         FROM notifications WHERE recipient_id = ? AND read_at IS NULL \
         ORDER BY created_at DESC LIMIT ?",
    )
    .bind(&[s(person_id), i(limit)])?
    .all()
    .await?
    .results::<NotificationRow>()
}

/// Insert one notification.
pub async fn insert_notification(
    db: &D1Database,
    recipient_id: &str,
    activity_id: Option<&str>,
    run_id: Option<&str>,
    kind: &str,
    message: &str,
    now: i64,
) -> Result<()> {
    let id = crate::util::new_id();
    db.prepare(
        "INSERT INTO notifications (id, recipient_id, activity_id, run_id, kind, message, read_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
    )
    .bind(&[
        s(&id),
        s(recipient_id),
        os(activity_id),
        os(run_id),
        s(kind),
        s(message),
        i(now),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Notify every committed participant of a run (optionally excluding one person).
pub async fn notify_committed(
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    exclude_person: Option<&str>,
    kind: &str,
    message: &str,
    now: i64,
) -> Result<Vec<String>> {
    let recipients = committed_person_ids(db, run_id, exclude_person).await?;

    let mut stmts = Vec::new();
    for person_id in &recipients {
        let id = crate::util::new_id();
        stmts.push(
            db.prepare(
                "INSERT INTO notifications (id, recipient_id, activity_id, run_id, kind, message, read_at, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            )
            .bind(&[s(&id), s(person_id), s(activity_id), s(run_id), s(kind), s(message), i(now)])?,
        );
    }
    if !stmts.is_empty() {
        db.batch(stmts).await?;
    }
    Ok(recipients)
}

pub async fn notify_interested(
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    kind: &str,
    message: &str,
    now: i64,
) -> Result<Vec<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        person_id: String,
    }
    let recipients = db
        .prepare("SELECT person_id FROM participations WHERE run_id = ? AND state = 'interested'")
        .bind(&[s(run_id)])?
        .all()
        .await?
        .results::<Row>()?;

    let people: Vec<String> = recipients.into_iter().map(|r| r.person_id).collect();
    let mut stmts = Vec::new();
    for person_id in &people {
        let id = crate::util::new_id();
        stmts.push(
            db.prepare(
                "INSERT INTO notifications (id, recipient_id, activity_id, run_id, kind, message, read_at, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            )
            .bind(&[s(&id), s(person_id), s(activity_id), s(run_id), s(kind), s(message), i(now)])?,
        );
    }
    if !stmts.is_empty() {
        db.batch(stmts).await?;
    }
    Ok(people)
}

/// Notify every person except one (broadcast, e.g. "new activity proposed").
pub async fn notify_all_except(
    db: &D1Database,
    exclude_person: &str,
    activity_id: Option<&str>,
    run_id: Option<&str>,
    kind: &str,
    message: &str,
    now: i64,
) -> Result<Vec<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        id: String,
    }
    let people = db
        .prepare("SELECT id FROM people WHERE id != ?")
        .bind(&[s(exclude_person)])?
        .all()
        .await?
        .results::<Row>()?;

    let mut stmts = Vec::new();
    for p in &people {
        let nid = crate::util::new_id();
        stmts.push(
            db.prepare(
                "INSERT INTO notifications (id, recipient_id, activity_id, run_id, kind, message, read_at, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            )
            .bind(&[s(&nid), s(&p.id), os(activity_id), os(run_id), s(kind), s(message), i(now)])?,
        );
    }
    if !stmts.is_empty() {
        db.batch(stmts).await?;
    }
    Ok(people.into_iter().map(|p| p.id).collect())
}

/// Mark notifications read for a person: specific ids, or all when `ids` is None.
pub async fn mark_notifications_read(
    db: &D1Database,
    person_id: &str,
    ids: Option<&[String]>,
    now: i64,
) -> Result<()> {
    match ids {
        None => {
            db.prepare(
                "UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL",
            )
            .bind(&[i(now), s(person_id)])?
            .run()
            .await?;
        }
        Some(ids) => {
            let mut stmts = Vec::new();
            for id in ids {
                stmts.push(
                    db.prepare(
                        "UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_id = ?",
                    )
                    .bind(&[i(now), s(id), s(person_id)])?,
                );
            }
            if !stmts.is_empty() {
                db.batch(stmts).await?;
            }
        }
    }
    Ok(())
}

// ---- maintenance (cron) ----------------------------------------------------

/// Minimal projection of a run that has passed its expiry.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExpiringRun {
    pub id: String,
    pub activity_id: String,
}

/// Find runs whose `expires_at` has passed and are still active
/// (open/ready/scheduled). Bounded by `limit` to keep the cron run within
/// the free-plan subrequest budget.
pub async fn expiring_runs(db: &D1Database, now: i64, limit: i64) -> Result<Vec<ExpiringRun>> {
    db.prepare(
        "SELECT id, activity_id FROM runs \
         WHERE expires_at IS NOT NULL AND expires_at <= ? \
           AND status IN ('open', 'ready', 'scheduled') \
         ORDER BY expires_at ASC LIMIT ?",
    )
    .bind(&[i(now), i(limit)])?
    .all()
    .await?
    .results::<ExpiringRun>()
}

/// Delete notifications to keep the table small on the free plan:
///   - read notifications older than `read_ttl_ms`
///   - any notification older than `hard_ttl_ms`
pub async fn prune_notifications(
    db: &D1Database,
    now: i64,
    read_ttl_ms: i64,
    hard_ttl_ms: i64,
) -> Result<()> {
    db.batch(vec![
        db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?")
            .bind(&[i(now - read_ttl_ms)])?,
        db.prepare("DELETE FROM notifications WHERE created_at < ?")
            .bind(&[i(now - hard_ttl_ms)])?,
    ])
    .await?;
    Ok(())
}
