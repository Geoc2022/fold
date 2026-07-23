//! HTTP handlers for the `/api/*` routes.

use worker::*;

use crate::db;
use crate::logic::{compute_group_state, grouping_is_feasible, GroupingMode};
use crate::models::*;
use crate::policy_store::{self, PolicyStoreError, ReplacePolicySetRequest};
use crate::push;
use crate::util::{
    err_json, expired_session_cookie, json_status, new_code, new_id, new_session_token, now_ms,
    random_color, session_cookie, session_token, session_token_hash, SESSION_TTL_MS,
};

const ACTIVITY_LIST_LIMIT: i64 = 100;
const NOTIFICATION_LIMIT: i64 = 50;
const DEFAULT_EMOJI: &str = "🎲";
const DEFAULT_CATEGORY: &str = "general";
const DEFAULT_COMMIT_SECONDS: i64 = 30 * 60;
const RESERVED_ACTIVITY_CODES: &[&str] = &["FOLD"];
/// Activities disappear from the homepage after this long without a run;
/// running the activity again resets the clock.
const ACTIVITY_VISIBLE_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Liveness tuning (see db.rs "heartbeat + reap"). A participant unreachable
/// longer than this is removed to keep rooms mostly live -- see
/// `docs/*` drop-matrix notes. Also used by the cron backstop in lib.rs.
pub(crate) const DESPONDENT_MS: i64 = 5 * 60 * 1000;
/// Only rewrite `last_seen_at` when it's already stale by this much, and
/// only for people who hold a participation row -- keeps the heartbeat
/// free-plan-safe (see `db::heartbeat`). Must stay well under the client's
/// ~60s "unreachable" dimming threshold so a genuinely-live poller never
/// crosses it.
const HEARTBEAT_COALESCE_MS: i64 = 30_000;

// ---- helpers ---------------------------------------------------------------

async fn require_person(
    db: &D1Database,
    req: &Request,
) -> Result<std::result::Result<PersonRow, Response>> {
    match optional_person(db, req).await? {
        Some(p) => Ok(Ok(p)),
        None => Ok(Err(err_json("missing or expired session", 401)?)),
    }
}

async fn optional_person(db: &D1Database, req: &Request) -> Result<Option<PersonRow>> {
    let Some(token) = session_token(req) else {
        return Ok(None);
    };
    db::person_for_session(db, &session_token_hash(&token), now_ms()).await
}

fn policy_store_error(error: PolicyStoreError) -> Result<Response> {
    let body = match &error {
        PolicyStoreError::Compile {
            rule_index,
            diagnostics,
        } => serde_json::json!({
            "error": error.to_string(),
            "rule_index": rule_index,
            "diagnostics": diagnostics,
        }),
        PolicyStoreError::Conflict {
            expected_revision,
            actual_revision,
        } => serde_json::json!({
            "error": error.to_string(),
            "expected_revision": expected_revision,
            "actual_revision": actual_revision,
        }),
        _ => serde_json::json!({ "error": error.to_string() }),
    };
    json_status(&body, error.status_code())
}

async fn push_people(env: &Env, db: &D1Database, people: Vec<String>) -> Result<()> {
    if !people.is_empty() {
        push::send_to_people(env, db, &people).await?;
    }
    Ok(())
}

async fn policy_event(
    env: &Env,
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    kind: &str,
    actor_id: Option<&str>,
) -> Result<()> {
    if let Err(error) =
        crate::policy_runtime::emit_event(env, db, activity_id, Some(run_id), kind, actor_id, 0)
            .await
    {
        console_error!("could not enqueue policy event: {error}");
    }
    Ok(())
}

async fn unique_activity_code(db: &D1Database) -> Result<String> {
    for _ in 0..12 {
        let code = new_code();
        if !RESERVED_ACTIVITY_CODES.contains(&code.as_str())
            && db::get_activity_by_code(db, &code).await?.is_none()
        {
            return Ok(code);
        }
    }
    Err(Error::RustError(
        "could not generate unique activity code".into(),
    ))
}

async fn validate_or_generate_activity_code(
    db: &D1Database,
    requested: Option<&str>,
) -> Result<std::result::Result<String, Response>> {
    let Some(raw) = requested else {
        return Ok(Ok(unique_activity_code(db).await?));
    };
    let code = raw.trim().to_ascii_uppercase();
    if code.is_empty() {
        return Ok(Ok(unique_activity_code(db).await?));
    }
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_alphabetic()) {
        return Ok(Err(err_json("code must be exactly 4 letters", 400)?));
    }
    if RESERVED_ACTIVITY_CODES.contains(&code.as_str()) {
        let body = serde_json::json!({ "error": "that code is reserved", "conflict": "code" });
        return Ok(Err(json_status(&body, 409)?));
    }
    if db::get_activity_by_code(db, &code).await?.is_some() {
        let body = serde_json::json!({ "error": "that code is already taken", "conflict": "code" });
        return Ok(Err(json_status(&body, 409)?));
    }
    Ok(Ok(code))
}

fn clean_emoji(raw: Option<&str>) -> String {
    let trimmed = raw.map(str::trim).unwrap_or("");
    if trimmed.is_empty() || trimmed.chars().count() > 8 {
        DEFAULT_EMOJI.to_string()
    } else {
        trimmed.to_string()
    }
}

fn clean_category(raw: Option<&str>) -> String {
    let trimmed = raw.map(str::trim).unwrap_or("");
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        DEFAULT_CATEGORY.to_string()
    } else {
        trimmed.to_lowercase()
    }
}

/// Recompute a run's counts, reconcile open/ready status against the
/// activity's grouping config, latch `reached_ready`, and return the fresh
/// row plus whether it just transitioned into "ready".
pub(crate) async fn refresh_run(
    db: &D1Database,
    run_id: &str,
    activity: &ActivityRow,
    now: i64,
) -> Result<(RunRow, bool)> {
    db::recompute_run_counts(db, run_id, now).await?;
    let mut run = db::get_run(db, run_id)
        .await?
        .ok_or_else(|| Error::RustError("run not found after update".into()))?;

    let gs = compute_group_state(
        GroupingMode::parse(&activity.grouping_mode),
        activity.min_people.max(0) as u32,
        activity.max_people.map(|m| m.max(0) as u32),
        activity.group_multiple.max(0) as u32,
        run.committed_count.max(0) as u32,
    );

    let mut newly_ready = false;
    if run.status == "open" && gs.is_ready {
        db::set_run_status(db, run_id, "ready", now).await?;
        run.status = "ready".to_string();
        newly_ready = true;
    } else if run.status == "ready" && !gs.is_ready {
        db::set_run_status(db, run_id, "open", now).await?;
        run.status = "open".to_string();
    }
    if gs.is_ready && run.reached_ready == 0 {
        db::mark_run_reached_ready(db, run_id).await?;
        run.reached_ready = 1;
    }
    Ok((run, newly_ready))
}

/// End a run (close/cancel/expire): freeze its status, roll its final counts
/// onto the activity's lifetime stats, and clear the activity's
/// `current_run_id` if it still points at this run (room goes back to
/// "empty", prompting a new proposal).
pub(crate) async fn end_run(
    db: &D1Database,
    run_id: &str,
    new_status: &str,
    now: i64,
) -> Result<Option<(RunRow, ActivityRow)>> {
    let Some(run) = db::get_run(db, run_id).await? else {
        return Ok(None);
    };
    let Some(activity) = db::get_activity(db, &run.activity_id).await? else {
        return Ok(None);
    };

    db::set_run_status(db, run_id, new_status, now).await?;

    let served = run.interested_count + run.committed_count;
    let times_run_inc = if run.reached_ready != 0 { 1 } else { 0 };
    db::rollup_activity_stats(
        db,
        &activity.id,
        times_run_inc,
        served,
        run.interested_count,
        run.committed_count,
        now,
    )
    .await?;

    if activity.current_run_id.as_deref() == Some(run_id) {
        db::set_activity_current_run(db, &activity.id, None, now).await?;
    }

    let fresh_run = db::get_run(db, run_id)
        .await?
        .ok_or_else(|| Error::RustError("run missing after update".into()))?;
    let fresh_activity = db::get_activity(db, &activity.id)
        .await?
        .ok_or_else(|| Error::RustError("activity missing after update".into()))?;
    Ok(Some((fresh_run, fresh_activity)))
}

/// Build an `ActivityView` by re-reading the activity's *live*
/// `current_run_id`, rather than trusting whatever run id a caller happened
/// to act on. This is the only correct way to answer "what does this
/// activity/room look like right now" after a mutation: a request might
/// target a run that has since ended (e.g. a stale client reference), and
/// the response should still reflect the activity's real current run (or
/// `None` if the room is genuinely empty) instead of echoing back a stale
/// or mismatched run.
async fn build_activity_view(
    db: &D1Database,
    activity_id: &str,
    my_person_id: Option<&str>,
) -> Result<Option<ActivityView>> {
    let Some(activity) = db::get_activity(db, activity_id).await? else {
        return Ok(None);
    };
    let run = match &activity.current_run_id {
        Some(rid) => db::get_run(db, rid).await?,
        None => None,
    };
    let (my_state, my_arrival_at) = match (&run, my_person_id) {
        (Some(r), Some(pid)) => match db::participation_for_person(db, &r.id, pid).await? {
            Some(part) => (Some(part.state), part.arrival_at),
            None => (None, None),
        },
        _ => (None, None),
    };
    Ok(Some(ActivityView::from_row(
        activity,
        run,
        my_state,
        my_arrival_at,
    )))
}

// ---- session ---------------------------------------------------------------

pub async fn session_create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: CreateSession = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    let raw_handle = body.handle.trim();
    let handle = if raw_handle.is_empty() {
        "guest"
    } else {
        raw_handle
    };
    if handle.chars().count() > 40 {
        return err_json("handle must be <= 40 characters", 400);
    }
    let db = ctx.env.d1("DB")?;
    let now = now_ms();
    let id = new_id();
    let color = body.color.unwrap_or_else(random_color);
    let (token, token_hash) = new_session_token();

    db.prepare(
        "INSERT INTO people (id, handle, color, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    )
    .bind(&[db::s(&id), db::s(handle), db::s(&color), db::i(now)])?
    .run()
    .await?;
    db::insert_auth_session(
        &db,
        &token_hash,
        &id,
        now,
        now.saturating_add(SESSION_TTL_MS),
    )
    .await?;

    let person = PersonRow {
        id,
        handle: handle.to_string(),
        color,
        created_at: now,
        last_seen_at: now,
    };
    let mut response = json_status(&person, 201)?;
    response
        .headers_mut()
        .set("Set-Cookie", &session_cookie(&req, &token)?)?;
    Ok(response)
}

pub async fn session_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    match optional_person(&db, &req).await? {
        Some(p) => Response::from_json(&p),
        None => err_json("missing or expired session", 401),
    }
}

pub async fn session_delete(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    if let Some(token) = session_token(&req) {
        db::delete_auth_session(&db, &session_token_hash(&token)).await?;
    }
    let mut response = Response::from_json(&serde_json::json!({ "ok": true }))?;
    response
        .headers_mut()
        .set("Set-Cookie", &expired_session_cookie(&req)?)?;
    Ok(response)
}

pub async fn session_update(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let body: UpdateSession = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    let handle = body
        .handle
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or(&person.handle);
    if handle.chars().count() > 40 {
        return err_json("handle must be 1-40 characters", 400);
    }
    let color = body.color.unwrap_or(person.color.clone());
    let now = now_ms();
    db.prepare("UPDATE people SET handle = ?, color = ?, last_seen_at = ? WHERE id = ?")
        .bind(&[db::s(handle), db::s(&color), db::i(now), db::s(&person.id)])?
        .run()
        .await?;
    let updated = PersonRow {
        id: person.id,
        handle: handle.to_string(),
        color,
        created_at: person.created_at,
        last_seen_at: now,
    };
    Response::from_json(&updated)
}

// ---- activities (create tile + first run) ----------------------------------

pub async fn activity_create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let proposer = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let body: CreateActivity = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };

    let title = body.title.trim();
    if title.is_empty() || title.chars().count() > 100 {
        return err_json("title must be 1-100 characters", 400);
    }
    if db::get_activity_by_title(&db, title).await?.is_some() {
        let response_body = serde_json::json!({
            "error": "an activity with this title already exists",
            "conflict": "title",
        });
        return json_status(&response_body, 409);
    }
    if body.min_people < 1 {
        return err_json("min_people must be >= 1", 400);
    }
    let group_multiple = body.group_multiple.unwrap_or(1).max(1);
    let grouping_mode = match body.grouping_mode.as_deref() {
        None | Some("single") => "single",
        Some("tiling") => "tiling",
        Some(_) => return err_json("grouping_mode must be 'single' or 'tiling'", 400),
    };
    if let Some(max) = body.max_people {
        if max < body.min_people {
            return err_json("max_people must be >= min_people", 400);
        }
    }
    if !grouping_is_feasible(
        GroupingMode::parse(grouping_mode),
        body.min_people,
        body.max_people,
        group_multiple,
    ) {
        return err_json(
            "this min/max/group-size combination can never form a complete group",
            400,
        );
    }

    let emoji = clean_emoji(body.emoji.as_deref());
    let category = clean_category(body.category.as_deref());
    let duration_seconds = body
        .duration_seconds
        .unwrap_or(30 * 60)
        .clamp(0, 24 * 60 * 60);
    let max_commit_seconds = body
        .max_commit_seconds
        .unwrap_or(30 * 60)
        .clamp(0, 24 * 60 * 60);

    let now = now_ms();
    let id = new_id();
    let run_id = new_id();
    let code = match validate_or_generate_activity_code(&db, body.code.as_deref()).await? {
        Ok(c) => c,
        Err(resp) => return Ok(resp),
    };

    db.prepare(
        "INSERT INTO activities \
          (id, code, emoji, title, description, category, proposer_id, min_people, max_people, group_multiple, \
            grouping_mode, allow_guests, private_by_link, duration_seconds, max_commit_seconds, current_run_id, times_run, \
            players_served, interest_total, commit_total, last_active_at, created_at, updated_at) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0, 0, 0, ?17, ?17, ?17)",
    )
    .bind(&[
        db::s(&id),
        db::s(&code),
        db::s(&emoji),
        db::s(title),
        db::os(body.description.as_deref()),
        db::s(&category),
        db::s(&proposer.id),
        db::i(body.min_people as i64),
        db::oi(body.max_people.map(|m| m as i64)),
        db::i(group_multiple as i64),
        db::s(grouping_mode),
        db::i(if body.allow_guests.unwrap_or(true) { 1 } else { 0 }),
        db::i(if body.private_by_link.unwrap_or(false) {
            1
        } else {
            0
        }),
        db::i(duration_seconds as i64),
        db::i(max_commit_seconds as i64),
        db::s(&run_id),
        db::i(now),
    ])?
    .run()
    .await?;

    db::insert_run(
        &db,
        &run_id,
        &id,
        body.location.as_deref(),
        body.details.as_deref(),
        body.scheduled_for,
        body.expires_at,
        now,
    )
    .await?;
    policy_event(
        &ctx.env,
        &db,
        &id,
        &run_id,
        "activity_created",
        Some(&proposer.id),
    )
    .await?;

    // Public activities are discoverable; private-by-link activities are not.
    if !body.private_by_link.unwrap_or(false) {
        let msg = format!("{} proposed \"{}\"", proposer.handle, title);
        let recipients = db::notify_all_except(
            &db,
            &proposer.id,
            Some(&id),
            Some(&run_id),
            "activity_proposed",
            &msg,
            now,
        )
        .await?;
        push_people(&ctx.env, &db, recipients).await?;
    }

    let view = build_activity_view(&db, &id, None)
        .await?
        .ok_or_else(|| Error::RustError("insert failed".into()))?;
    json_status(&view, 201)
}

pub async fn activity_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let id = ctx.param("id").cloned().unwrap_or_default();
    let me = optional_person(&db, &req).await?;
    match build_activity_view(&db, &id, me.as_ref().map(|p| p.id.as_str())).await? {
        Some(view) => Response::from_json(&view),
        None => err_json("activity not found", 404),
    }
}

pub async fn activity_update(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    let existing = match db::get_activity(&db, &id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if existing.proposer_id != person.id {
        return err_json("only the proposer can edit this activity", 403);
    }

    let body: UpdateActivity = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };

    let title = body.title.trim();
    if title.is_empty() || title.chars().count() > 100 {
        return err_json("title must be 1-100 characters", 400);
    }
    if let Some(conflict) = db::get_activity_by_title(&db, title).await? {
        if conflict.id != existing.id {
            let response_body = serde_json::json!({
                "error": "an activity with this title already exists",
                "conflict": "title",
            });
            return json_status(&response_body, 409);
        }
    }
    if body.min_people < 1 {
        return err_json("min_people must be >= 1", 400);
    }
    let group_multiple = body.group_multiple.unwrap_or(1).max(1);
    let grouping_mode = match body.grouping_mode.as_deref() {
        None | Some("single") => "single",
        Some("tiling") => "tiling",
        Some(_) => return err_json("grouping_mode must be 'single' or 'tiling'", 400),
    };
    if let Some(max) = body.max_people {
        if max < body.min_people {
            return err_json("max_people must be >= min_people", 400);
        }
    }
    if !grouping_is_feasible(
        GroupingMode::parse(grouping_mode),
        body.min_people,
        body.max_people,
        group_multiple,
    ) {
        return err_json(
            "this min/max/group-size combination can never form a complete group",
            400,
        );
    }

    let emoji = clean_emoji(body.emoji.as_deref());
    let category = clean_category(body.category.as_deref());
    let duration_seconds = body
        .duration_seconds
        .unwrap_or(30 * 60)
        .clamp(0, 24 * 60 * 60);
    let max_commit_seconds = body
        .max_commit_seconds
        .unwrap_or(30 * 60)
        .clamp(0, 24 * 60 * 60);
    let now = now_ms();

    db.prepare(
        "UPDATE activities SET \
            emoji = ?1, title = ?2, description = ?3, category = ?4, \
            min_people = ?5, max_people = ?6, group_multiple = ?7, grouping_mode = ?8, \
            allow_guests = ?9, private_by_link = ?10, duration_seconds = ?11, \
            max_commit_seconds = ?12, updated_at = ?13 \
         WHERE id = ?14",
    )
    .bind(&[
        db::s(&emoji),
        db::s(title),
        db::os(body.description.as_deref()),
        db::s(&category),
        db::i(body.min_people as i64),
        db::oi(body.max_people.map(|m| m as i64)),
        db::i(group_multiple as i64),
        db::s(grouping_mode),
        db::i(if body.allow_guests.unwrap_or(true) {
            1
        } else {
            0
        }),
        db::i(if body.private_by_link.unwrap_or(false) {
            1
        } else {
            0
        }),
        db::i(duration_seconds as i64),
        db::i(max_commit_seconds as i64),
        db::i(now),
        db::s(&existing.id),
    ])?
    .run()
    .await?;

    if let Some(updated) = db::get_activity(&db, &existing.id).await? {
        if let Some(run_id) = updated.current_run_id.clone() {
            let _ = refresh_run(&db, &run_id, &updated, now).await?;
            policy_event(
                &ctx.env,
                &db,
                &updated.id,
                &run_id,
                "activity_updated",
                Some(&person.id),
            )
            .await?;
        }
    }

    match build_activity_view(&db, &existing.id, Some(&person.id)).await? {
        Some(view) => Response::from_json(&view),
        None => err_json("activity not found", 404),
    }
}

pub async fn activity_delete(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    let existing = match db::get_activity(&db, &id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if existing.proposer_id != person.id {
        return err_json("only the proposer can delete this activity", 403);
    }
    db.prepare("DELETE FROM activities WHERE id = ?")
        .bind(&[db::s(&existing.id)])?
        .run()
        .await?;
    Response::from_json(&serde_json::json!({ "ok": true }))
}

/// Create a new run on an existing activity whose room is currently empty
/// (no active run). Inherits grouping/code/emoji from the activity; the
/// caller only supplies time/location/details, defaulting to the last run
/// on the client side.
pub async fn activity_create_run(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let proposer = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    let activity = match db::get_activity(&db, &id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if activity.current_run_id.is_some() {
        return err_json("this activity already has an active run", 409);
    }
    let body: CreateRun = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };

    let now = now_ms();
    let run_id = new_id();
    db::insert_run(
        &db,
        &run_id,
        &activity.id,
        body.location.as_deref(),
        body.details.as_deref(),
        body.scheduled_for,
        body.expires_at,
        now,
    )
    .await?;
    db::set_activity_current_run(&db, &activity.id, Some(&run_id), now).await?;
    db::touch_activity_last_active(&db, &activity.id, now).await?;
    policy_event(
        &ctx.env,
        &db,
        &activity.id,
        &run_id,
        "run_created",
        Some(&proposer.id),
    )
    .await?;

    if activity.private_by_link == 0 {
        let msg = format!(
            "{} proposed a new run of \"{}\"",
            proposer.handle, activity.title
        );
        let recipients = db::notify_all_except(
            &db,
            &proposer.id,
            Some(&activity.id),
            Some(&run_id),
            "run_proposed",
            &msg,
            now,
        )
        .await?;
        push_people(&ctx.env, &db, recipients).await?;
    }

    let view = build_activity_view(&db, &activity.id, None)
        .await?
        .ok_or_else(|| Error::RustError("missing".into()))?;
    json_status(&view, 201)
}

// ---- participation (on runs) ------------------------------------------------

pub async fn run_interest(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let run_id = ctx.param("id").cloned().unwrap_or_default();
    let run = match db::get_run(&db, &run_id).await? {
        Some(r) => r,
        None => return err_json("run not found", 404),
    };
    if !matches!(run.status.as_str(), "open" | "ready" | "scheduled") {
        return err_json("run is not accepting participants", 409);
    }
    let activity = match db::get_activity(&db, &run.activity_id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };

    let now = now_ms();
    // Reap this run's ghosts first so `prior_interested` (and the
    // min_people-crossing check below) reflect real people, not stale
    // despondent/event-over participations.
    let run = if db::reap_run(&db, &run.id, now, now - DESPONDENT_MS).await? {
        refresh_run(&db, &run.id, &activity, now).await?.0
    } else {
        run
    };
    let prior_interested = run.interested_count;
    db::upsert_participation(&db, &run.id, &person.id, "interested", None, now).await?;
    db::touch_person(&db, &person.id, now).await?;
    db::touch_activity_last_active(&db, &activity.id, now).await?;

    let (fresh_run, _newly_ready) = refresh_run(&db, &run.id, &activity, now).await?;
    policy_event(
        &ctx.env,
        &db,
        &activity.id,
        &run.id,
        "participation_changed",
        Some(&person.id),
    )
    .await?;

    if activity.proposer_id != person.id {
        let msg = format!("{} is interested in \"{}\"", person.handle, activity.title);
        db::insert_notification(
            &db,
            &activity.proposer_id,
            Some(&activity.id),
            Some(&run.id),
            "interest_added",
            &msg,
            now,
        )
        .await?;
        push_people(&ctx.env, &db, vec![activity.proposer_id.clone()]).await?;
    }

    if prior_interested < activity.min_people && fresh_run.interested_count >= activity.min_people {
        let msg = format!("\"{}\" has enough interested people", activity.title);
        let recipients = db::notify_interested(
            &db,
            &activity.id,
            &run.id,
            "activity_interest_ready",
            &msg,
            now,
        )
        .await?;
        push_people(&ctx.env, &db, recipients).await?;
    }

    let view = build_activity_view(&db, &activity.id, Some(&person.id))
        .await?
        .ok_or_else(|| Error::RustError("activity missing after update".into()))?;
    Response::from_json(&view)
}

pub async fn run_commit(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let run_id = ctx.param("id").cloned().unwrap_or_default();
    let run = match db::get_run(&db, &run_id).await? {
        Some(r) => r,
        None => return err_json("run not found", 404),
    };
    if !matches!(run.status.as_str(), "open" | "ready") {
        return err_json("run is not accepting commitments", 409);
    }
    let activity = match db::get_activity(&db, &run.activity_id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };

    let now = now_ms();
    let despondent_cutoff = now - DESPONDENT_MS;
    // Reap ghosts before evaluating capacity/exclusivity, so a stale
    // participation (someone else's despondent commit filling `max_people`,
    // or this person's own despondent/event-over commit elsewhere) never
    // blocks a live person from committing. `reap_person` is the automatic
    // "clear my stuck commit" escape hatch for the exclusive-commit lock.
    let run = if db::reap_run(&db, &run.id, now, despondent_cutoff).await? {
        refresh_run(&db, &run.id, &activity, now).await?.0
    } else {
        run
    };
    // reap_person can clear a stale commit on a *different* run (that's the
    // whole point -- clearing the exclusive-lock deadlock). That other
    // run's denormalized counts/readiness need their own refresh, since
    // refresh_run above only re-derived *this* run.
    let other_reaped_run_ids = db::reap_person(&db, &person.id, now, despondent_cutoff).await?;
    for other_run_id in &other_reaped_run_ids {
        if other_run_id == &run.id {
            continue; // already covered by the refresh_run call above
        }
        if let Some(other_run) = db::get_run(&db, other_run_id).await? {
            if let Some(other_activity) = db::get_activity(&db, &other_run.activity_id).await? {
                refresh_run(&db, other_run_id, &other_activity, now).await?;
            }
        }
    }

    let current = db::participation_state(&db, &run.id, &person.id).await?;
    let already_committed = current.as_deref() == Some("committed");

    if !already_committed {
        // Exclusive commit: at most one committed run per person, globally.
        if let Some(other) = db::other_committed_run(&db, &person.id, &run.id).await? {
            let body = serde_json::json!({
                "error": "already committed to another activity",
                "conflict_activity_id": other.activity_id,
                "conflict_run_id": other.run_id,
            });
            return json_status(&body, 409);
        }
        if let Some(max) = activity.max_people {
            if run.committed_count + 1 > max {
                return err_json("activity is full", 409);
            }
        }
    }

    let body_text = req.text().await.unwrap_or_default();
    let body: CommitRun = if body_text.trim().is_empty() {
        CommitRun { eta_seconds: None }
    } else {
        match serde_json::from_str(&body_text) {
            Ok(b) => b,
            Err(_) => return err_json("invalid JSON body", 400),
        }
    };

    // Re-stamp `now` after the body read (an await point) rather than
    // reusing the pre-reap timestamp, matching prior behavior.
    let now = now_ms();
    let max_commit = activity.max_commit_seconds.max(0);
    let default_eta = max_commit.min(DEFAULT_COMMIT_SECONDS);
    let requested_eta = body.eta_seconds.map(|v| v as i64).unwrap_or(default_eta);
    let eta = requested_eta.clamp(0, max_commit);
    let arrival_at = now + eta * 1000;
    if let Err(error) =
        db::upsert_participation(&db, &run.id, &person.id, "committed", Some(arrival_at), now).await
    {
        if error.to_string().contains("activity is full") {
            return err_json("activity is full", 409);
        }
        if let Some(other) = db::other_committed_run(&db, &person.id, &run.id).await? {
            let body = serde_json::json!({
                "error": "already committed to another activity",
                "conflict_activity_id": other.activity_id,
                "conflict_run_id": other.run_id,
            });
            return json_status(&body, 409);
        }
        return Err(error);
    }
    db::touch_person(&db, &person.id, now).await?;
    db::touch_activity_last_active(&db, &activity.id, now).await?;

    let (_fresh_run, newly_ready) = refresh_run(&db, &run.id, &activity, now).await?;
    policy_event(
        &ctx.env,
        &db,
        &activity.id,
        &run.id,
        "participation_changed",
        Some(&person.id),
    )
    .await?;

    if !already_committed && activity.proposer_id != person.id {
        let msg = format!("{} committed to \"{}\"", person.handle, activity.title);
        db::insert_notification(
            &db,
            &activity.proposer_id,
            Some(&activity.id),
            Some(&run.id),
            "commit_added",
            &msg,
            now,
        )
        .await?;
        push_people(&ctx.env, &db, vec![activity.proposer_id.clone()]).await?;
    }
    if newly_ready {
        let msg = format!("\"{}\" has enough people — it's on!", activity.title);
        let mut recipients = db::notify_committed(
            &db,
            &activity.id,
            &run.id,
            None,
            "activity_ready",
            &msg,
            now,
        )
        .await?;
        if activity.proposer_id != person.id {
            db::insert_notification(
                &db,
                &activity.proposer_id,
                Some(&activity.id),
                Some(&run.id),
                "activity_ready",
                &msg,
                now,
            )
            .await?;
            recipients.push(activity.proposer_id.clone());
        }
        push_people(&ctx.env, &db, recipients).await?;
    }

    let view = build_activity_view(&db, &activity.id, Some(&person.id))
        .await?
        .ok_or_else(|| Error::RustError("activity missing after update".into()))?;
    Response::from_json(&view)
}

pub async fn run_withdraw(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let run_id = ctx.param("id").cloned().unwrap_or_default();
    let run = match db::get_run(&db, &run_id).await? {
        Some(r) => r,
        None => return err_json("run not found", 404),
    };
    let activity = match db::get_activity(&db, &run.activity_id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };

    let now = now_ms();
    db::delete_participation(&db, &run.id, &person.id).await?;
    db::touch_person(&db, &person.id, now).await?;

    // Only re-derive open/ready status if this is still the activity's
    // active run -- withdrawing from a long-closed run (a stale client
    // reference) shouldn't resurrect it.
    if activity.current_run_id.as_deref() == Some(run.id.as_str()) {
        refresh_run(&db, &run.id, &activity, now).await?;
    }
    policy_event(
        &ctx.env,
        &db,
        &activity.id,
        &run.id,
        "participation_changed",
        Some(&person.id),
    )
    .await?;

    let view = build_activity_view(&db, &activity.id, Some(&person.id))
        .await?
        .ok_or_else(|| Error::RustError("activity missing after update".into()))?;
    Response::from_json(&view)
}

// ---- proposer actions (on runs) ---------------------------------------------

async fn proposer_run_action(
    req: &Request,
    ctx: &RouteContext<()>,
    new_status: &str,
    schedule: Option<ScheduleRun>,
    notify_kind: &str,
) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let run_id = ctx.param("id").cloned().unwrap_or_default();
    let run = match db::get_run(&db, &run_id).await? {
        Some(r) => r,
        None => return err_json("run not found", 404),
    };
    let activity = match db::get_activity(&db, &run.activity_id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if activity.proposer_id != person.id {
        return err_json("only the proposer can do that", 403);
    }

    let now = now_ms();
    if new_status == "scheduled" {
        let sched = schedule.ok_or_else(|| Error::RustError("schedule payload required".into()))?;
        db::set_run_schedule(
            &db,
            &run.id,
            "scheduled",
            sched.scheduled_for,
            sched.location.as_deref(),
            now,
        )
        .await?;
    } else {
        // closed or cancelled -- ends the run and rolls its stats onto the activity.
        if end_run(&db, &run.id, new_status, now).await?.is_none() {
            return err_json("run not found", 404);
        }
    };

    let msg = match new_status {
        "scheduled" => format!("\"{}\" is scheduled", activity.title),
        "cancelled" => format!("\"{}\" was cancelled", activity.title),
        "closed" => format!("\"{}\" was closed", activity.title),
        _ => format!("\"{}\" was updated", activity.title),
    };
    let recipients = db::notify_committed(
        &db,
        &activity.id,
        &run.id,
        Some(&person.id),
        notify_kind,
        &msg,
        now,
    )
    .await?;
    push_people(&ctx.env, &db, recipients).await?;
    policy_event(
        &ctx.env,
        &db,
        &activity.id,
        &run.id,
        "run_changed",
        Some(&person.id),
    )
    .await?;

    let view = build_activity_view(&db, &activity.id, Some(&person.id))
        .await?
        .ok_or_else(|| Error::RustError("activity missing after update".into()))?;
    Response::from_json(&view)
}

pub async fn run_schedule(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let sched: ScheduleRun = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    proposer_run_action(&req, &ctx, "scheduled", Some(sched), "activity_scheduled").await
}

pub async fn run_close(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    proposer_run_action(&req, &ctx, "closed", None, "activity_closed").await
}

pub async fn run_cancel(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    proposer_run_action(&req, &ctx, "cancelled", None, "activity_cancelled").await
}

// ---- notifications ---------------------------------------------------------

pub async fn notifications_read(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let body: MarkRead = req.json().await.unwrap_or(MarkRead { ids: None });
    let now = now_ms();
    db::mark_notifications_read(&db, &person.id, body.ids.as_deref(), now).await?;
    Response::from_json(&serde_json::json!({ "ok": true }))
}

// ---- push subscriptions -----------------------------------------------------

#[derive(serde::Deserialize, serde::Serialize)]
struct PushDeliveryDiagnostic {
    notification_id: String,
    status: String,
    attempts: i64,
    last_status: Option<i64>,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(serde::Deserialize)]
struct PushSubscriptionCount {
    active_subscriptions: i64,
}

pub async fn push_public_key(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let key = push::public_key(&ctx.env);
    Response::from_json(&serde_json::json!({
        "enabled": key.is_some(),
        "public_key": key,
    }))
}

pub async fn push_subscribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let body: PushSubscribe = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    if body.endpoint.trim().is_empty()
        || body.keys.p256dh.trim().is_empty()
        || body.keys.auth.trim().is_empty()
    {
        return err_json("invalid push subscription", 400);
    }
    let endpoint = match Url::parse(&body.endpoint) {
        Ok(url) if url.scheme() == "https" && url.host_str().is_some() => body.endpoint,
        _ => return err_json("push endpoint must be an HTTPS URL", 400),
    };
    if let Err(error) =
        crate::push_crypto::validate_subscription(&body.keys.p256dh, &body.keys.auth)
    {
        return err_json(&format!("invalid push subscription: {error}"), 400);
    }
    let now = now_ms();
    db::upsert_push_subscription(
        &db,
        &person.id,
        &endpoint,
        &body.keys.p256dh,
        &body.keys.auth,
        body.expiration_time,
        now,
    )
    .await?;
    let origin = Url::parse(&endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    console_log!(
        "[fold:push] subscription_upsert person={} origin={}",
        person.id,
        origin
    );
    Response::from_json(&serde_json::json!({ "ok": true }))
}

pub async fn push_unsubscribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let body: PushUnsubscribe = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    db::delete_push_subscription(&db, &person.id, &body.endpoint).await?;
    console_log!("[fold:push] subscription_deleted person={}", person.id);
    Response::from_json(&serde_json::json!({ "ok": true }))
}

pub async fn push_diagnostics(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(person) => person,
        Err(response) => return Ok(response),
    };
    let subscription = db
        .prepare(
            "SELECT COUNT(*) AS active_subscriptions FROM push_subscriptions \
             WHERE person_id = ?1 AND disabled_at IS NULL \
               AND (expiration_time IS NULL OR expiration_time > ?2)",
        )
        .bind(&[db::s(&person.id), db::i(now_ms())])?
        .first::<PushSubscriptionCount>(None)
        .await?
        .unwrap_or(PushSubscriptionCount {
            active_subscriptions: 0,
        });
    let deliveries = db
        .prepare(
            "SELECT pd.notification_id, pd.status, pd.attempts, pd.last_status, pd.last_error, \
                    pd.created_at, pd.updated_at \
             FROM push_deliveries pd \
             JOIN notifications n ON n.id = pd.notification_id \
             WHERE n.recipient_id = ?1 ORDER BY pd.updated_at DESC LIMIT 20",
        )
        .bind(&[db::s(&person.id)])?
        .all()
        .await?
        .results::<PushDeliveryDiagnostic>()?;
    Response::from_json(&serde_json::json!({
        "vapid_enabled": push::public_key(&ctx.env).is_some(),
        "active_subscriptions": subscription.active_subscriptions,
        "recent_deliveries": deliveries,
    }))
}

pub async fn push_test(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(person) => person,
        Err(response) => return Ok(response),
    };
    let queued = crate::policy_runtime::queue_test_push(&ctx.env, &db, &person.id).await?;
    json_status(&queued, 202)
}

// ---- personal policies -----------------------------------------------------

pub async fn policies_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(person) => person,
        Err(response) => return Ok(response),
    };
    let url = req.url()?;
    let activity_id = url
        .query_pairs()
        .find_map(|(key, value)| (key == "activity_id").then(|| value.into_owned()));
    match policy_store::get_policy_sets_for_api(&db, &person.id, activity_id.as_deref()).await {
        Ok(sets) => Response::from_json(&sets),
        Err(error) => policy_store_error(error),
    }
}

pub async fn policies_replace(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(person) => person,
        Err(response) => return Ok(response),
    };
    let request: ReplacePolicySetRequest = match req.json().await {
        Ok(request) => request,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    let scope = request.scope;
    let activity_id = request.activity_id.clone();
    match policy_store::replace_policy_set(&db, &person.id, request, now_ms()).await {
        Ok(set) => {
            if let Err(error) = crate::policy_runtime::policy_set_changed(
                &ctx.env,
                &db,
                &person.id,
                scope,
                activity_id.as_deref(),
            )
            .await
            {
                console_error!("could not enqueue changed policy set: {error}");
            }
            Response::from_json(&set)
        }
        Err(error) => policy_store_error(error),
    }
}

// ---- activity rooms ---------------------------------------------------------

pub async fn room_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let code = ctx.param("code").cloned().unwrap_or_default();
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_alphabetic()) {
        return err_json("activity code must be 4 letters", 400);
    }
    let row = match db::get_activity_by_code(&db, &code).await? {
        Some(r) => r,
        None => return err_json("activity not found", 404),
    };
    let me = optional_person(&db, &req).await?;
    let me_id = me.as_ref().map(|p| p.id.clone());
    let now = now_ms();

    if crate::util::request_has_same_origin_context(&req)? {
        if let Some(pid) = &me_id {
            db::heartbeat(&db, pid, now, HEARTBEAT_COALESCE_MS).await?;
            let presence = db
            .prepare(
                "INSERT INTO room_presence (activity_id, person_id, last_seen_at) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(activity_id, person_id) DO UPDATE SET last_seen_at = excluded.last_seen_at \
                 WHERE room_presence.last_seen_at <= excluded.last_seen_at - ?4",
            )
            .bind(&[
                db::s(&row.id),
                db::s(pid),
                db::i(now),
                db::i(HEARTBEAT_COALESCE_MS),
            ])?
            .run()
            .await?;
            if presence.meta()?.and_then(|meta| meta.changes).unwrap_or(0) != 0 {
                if let Some(run_id) = row.current_run_id.as_deref() {
                    policy_event(
                        &ctx.env,
                        &db,
                        &row.id,
                        run_id,
                        "presence_changed",
                        Some(pid),
                    )
                    .await?;
                }
            }
        }
    }
    // Lazy reap: this is the primary "look at the room" read path, so keep
    // its participant list/counts free of despondent or event-over ghosts
    // before anyone sees them, rather than waiting on the 15-min cron.
    if let Some(run_id) = &row.current_run_id {
        if db::reap_run(&db, run_id, now, now - DESPONDENT_MS).await? {
            refresh_run(&db, run_id, &row, now).await?;
        }
    }

    let view = match build_activity_view(&db, &row.id, me_id.as_deref()).await? {
        Some(v) => v,
        None => return err_json("activity not found", 404),
    };
    let participants = match &view.current_run {
        Some(r) => db::participants_for_run(&db, &r.id, me_id.as_deref()).await?,
        None => Vec::new(),
    };
    let other_commitment = match (&view.current_run, &me_id) {
        (Some(r), Some(pid)) => db::other_committed_run(&db, pid, &r.id).await?,
        _ => None,
    };
    let already_committed_elsewhere = other_commitment.is_some();
    let resp = RoomResponse {
        server_time: now_ms(),
        activity: view,
        participants,
        already_committed_elsewhere,
        other_committed_room_code: other_commitment.as_ref().map(|c| c.activity_code.clone()),
        other_committed_activity_title: other_commitment.as_ref().map(|c| c.activity_title.clone()),
    };
    Response::from_json(&resp)
}

// ---- sync ------------------------------------------------------------------

pub async fn sync(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let now = now_ms();

    let me = optional_person(&db, &req).await?;
    let me_id = me.as_ref().map(|p| p.id.clone());
    if let Some(pid) = &me_id {
        db::heartbeat(&db, pid, now, HEARTBEAT_COALESCE_MS).await?;
    }
    let since = now - ACTIVITY_VISIBLE_WINDOW_MS;
    let activities = db::list_activities(&db, since, ACTIVITY_LIST_LIMIT).await?;

    let run_ids: Vec<String> = activities
        .iter()
        .filter_map(|a| a.current_run_id.clone())
        .collect();
    let runs = db::get_runs_by_ids(&db, &run_ids).await?;
    let run_by_id: std::collections::HashMap<String, RunRow> =
        runs.into_iter().map(|r| (r.id.clone(), r)).collect();

    let (my_states, notifications) = match &me {
        Some(p) => {
            let parts = db::participations_for_person(&db, &p.id).await?;
            let map: std::collections::HashMap<String, ParticipationLite> =
                parts.into_iter().map(|x| (x.run_id.clone(), x)).collect();
            let notifs = db::unread_notifications(&db, &p.id, NOTIFICATION_LIMIT).await?;
            (map, notifs)
        }
        None => (std::collections::HashMap::new(), Vec::new()),
    };

    let views: Vec<ActivityView> = activities
        .into_iter()
        .map(|row| {
            let run = row
                .current_run_id
                .as_ref()
                .and_then(|rid| run_by_id.get(rid).cloned());
            let my_part = run.as_ref().and_then(|r| my_states.get(&r.id));
            let my_state = my_part.map(|p| p.state.clone());
            let my_arrival_at = my_part.and_then(|p| p.arrival_at);
            ActivityView::from_row(row, run, my_state, my_arrival_at)
        })
        .collect();

    let resp = SyncResponse {
        server_time: now,
        me,
        activities: views,
        notifications,
    };
    Response::from_json(&resp)
}
