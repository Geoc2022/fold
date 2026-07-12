//! HTTP handlers for the `/api/*` routes.

use worker::*;

use crate::db;
use crate::logic::{compute_group_state, grouping_is_feasible, GroupingMode};
use crate::models::*;
use crate::push;
use crate::util::{err_json, json_status, new_code, new_id, now_ms, person_id, random_color};

const ACTIVITY_LIST_LIMIT: i64 = 100;
const NOTIFICATION_LIMIT: i64 = 50;
const DEFAULT_EMOJI: &str = "🎲";
const DEFAULT_CATEGORY: &str = "general";
/// Activities disappear from the homepage after this long without a run;
/// running the activity again resets the clock.
const ACTIVITY_VISIBLE_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

// ---- helpers ---------------------------------------------------------------

async fn require_person(db: &D1Database, req: &Request) -> Result<std::result::Result<PersonRow, Response>> {
    let pid = match person_id(req) {
        Some(p) => p,
        None => return Ok(Err(err_json("missing X-Person-Id header", 401)?)),
    };
    match db::get_person(db, &pid).await? {
        Some(p) => Ok(Ok(p)),
        None => Ok(Err(err_json("unknown person; create a session first", 401)?)),
    }
}

async fn push_people(env: &Env, db: &D1Database, people: Vec<String>) -> Result<()> {
    if !people.is_empty() {
        push::send_to_people(env, db, &people).await?;
    }
    Ok(())
}

async fn unique_activity_code(db: &D1Database) -> Result<String> {
    for _ in 0..12 {
        let code = new_code();
        if db::get_activity_by_code(db, &code).await?.is_none() {
            return Ok(code);
        }
    }
    Err(Error::RustError("could not generate unique activity code".into()))
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
async fn refresh_run(db: &D1Database, run_id: &str, activity: &ActivityRow, now: i64) -> Result<(RunRow, bool)> {
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
pub(crate) async fn end_run(db: &D1Database, run_id: &str, new_status: &str, now: i64) -> Result<Option<(RunRow, ActivityRow)>> {
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
    let my_state = match (&run, my_person_id) {
        (Some(r), Some(pid)) => db::participation_state(db, &r.id, pid).await?,
        _ => None,
    };
    Ok(Some(ActivityView::from_row(activity, run, my_state)))
}

// ---- session ---------------------------------------------------------------

pub async fn session_create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: CreateSession = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    let raw_handle = body.handle.trim();
    let handle = if raw_handle.is_empty() { "guest" } else { raw_handle };
    if handle.chars().count() > 40 {
        return err_json("handle must be <= 40 characters", 400);
    }
    let db = ctx.env.d1("DB")?;
    let now = now_ms();
    let id = new_id();
    let color = body.color.unwrap_or_else(random_color);

    db.prepare(
        "INSERT INTO people (id, handle, color, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    )
    .bind(&[db::s(&id), db::s(handle), db::s(&color), db::i(now)])?
    .run()
    .await?;

    let person = PersonRow {
        id,
        handle: handle.to_string(),
        color,
        created_at: now,
        last_seen_at: now,
    };
    json_status(&person, 201)
}

pub async fn session_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let pid = match person_id(&req) {
        Some(p) => p,
        None => return err_json("missing X-Person-Id header", 401),
    };
    match db::get_person(&db, &pid).await? {
        Some(p) => Response::from_json(&p),
        None => err_json("not found", 404),
    }
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
            grouping_mode, allow_guests, current_run_id, times_run, players_served, interest_total, commit_total, \
            last_active_at, created_at, updated_at) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, 0, 0, ?14, ?14, ?14)",
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

    // Broadcast to everyone else so the new activity is discoverable.
    let msg = format!("{} proposed \"{}\"", proposer.handle, title);
    let recipients =
        db::notify_all_except(&db, &proposer.id, Some(&id), Some(&run_id), "activity_proposed", &msg, now).await?;
    push_people(&ctx.env, &db, recipients).await?;

    let view = build_activity_view(&db, &id, None)
        .await?
        .ok_or_else(|| Error::RustError("insert failed".into()))?;
    json_status(&view, 201)
}

pub async fn activity_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let id = ctx.param("id").cloned().unwrap_or_default();
    match build_activity_view(&db, &id, person_id(&req).as_deref()).await? {
        Some(view) => Response::from_json(&view),
        None => err_json("activity not found", 404),
    }
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

    let msg = format!("{} proposed a new run of \"{}\"", proposer.handle, activity.title);
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
    let prior_interested = run.interested_count;
    db::upsert_participation(&db, &run.id, &person.id, "interested", None, now).await?;
    db::touch_person(&db, &person.id, now).await?;
    db::touch_activity_last_active(&db, &activity.id, now).await?;

    let (fresh_run, _newly_ready) = refresh_run(&db, &run.id, &activity, now).await?;

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
        let recipients =
            db::notify_interested(&db, &activity.id, &run.id, "activity_interest_ready", &msg, now).await?;
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
        CommitRun { eta_minutes: None }
    } else {
        match serde_json::from_str(&body_text) {
            Ok(b) => b,
            Err(_) => return err_json("invalid JSON body", 400),
        }
    };

    let now = now_ms();
    let eta = body.eta_minutes.unwrap_or(30).min(30) as i64;
    let arrival_at = now + eta * 60 * 1000;
    db::upsert_participation(&db, &run.id, &person.id, "committed", Some(arrival_at), now).await?;
    db::touch_person(&db, &person.id, now).await?;
    db::touch_activity_last_active(&db, &activity.id, now).await?;

    let (_fresh_run, newly_ready) = refresh_run(&db, &run.id, &activity, now).await?;

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
        let mut recipients =
            db::notify_committed(&db, &activity.id, &run.id, None, "activity_ready", &msg, now).await?;
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
        db::set_run_schedule(&db, &run.id, "scheduled", sched.scheduled_for, sched.location.as_deref(), now).await?;
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
    let recipients = db::notify_committed(&db, &activity.id, &run.id, Some(&person.id), notify_kind, &msg, now).await?;
    push_people(&ctx.env, &db, recipients).await?;

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
    let now = now_ms();
    db::upsert_push_subscription(
        &db,
        &person.id,
        &body.endpoint,
        &body.keys.p256dh,
        &body.keys.auth,
        now,
    )
    .await?;
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
    Response::from_json(&serde_json::json!({ "ok": true }))
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
    let me_id = person_id(&req);
    let view = match build_activity_view(&db, &row.id, me_id.as_deref()).await? {
        Some(v) => v,
        None => return err_json("activity not found", 404),
    };
    let participants = match &view.current_run {
        Some(r) => db::participants_for_run(&db, &r.id, me_id.as_deref()).await?,
        None => Vec::new(),
    };
    let resp = RoomResponse {
        server_time: now_ms(),
        activity: view,
        participants,
    };
    Response::from_json(&resp)
}

// ---- sync ------------------------------------------------------------------

pub async fn sync(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let now = now_ms();

    let me_id = person_id(&req);
    let me = match &me_id {
        Some(pid) => db::get_person(&db, pid).await?,
        None => None,
    };

    let since = now - ACTIVITY_VISIBLE_WINDOW_MS;
    let activities = db::list_activities(&db, since, ACTIVITY_LIST_LIMIT).await?;

    let run_ids: Vec<String> = activities.iter().filter_map(|a| a.current_run_id.clone()).collect();
    let runs = db::get_runs_by_ids(&db, &run_ids).await?;
    let run_by_id: std::collections::HashMap<String, RunRow> =
        runs.into_iter().map(|r| (r.id.clone(), r)).collect();

    let (my_states, notifications) = match &me {
        Some(p) => {
            let parts = db::participations_for_person(&db, &p.id).await?;
            let map: std::collections::HashMap<String, String> =
                parts.into_iter().map(|x| (x.run_id, x.state)).collect();
            let notifs = db::unread_notifications(&db, &p.id, NOTIFICATION_LIMIT).await?;
            (map, notifs)
        }
        None => (std::collections::HashMap::new(), Vec::new()),
    };

    let views: Vec<ActivityView> = activities
        .into_iter()
        .map(|row| {
            let run = row.current_run_id.as_ref().and_then(|rid| run_by_id.get(rid).cloned());
            let my_state = run.as_ref().and_then(|r| my_states.get(&r.id).cloned());
            ActivityView::from_row(row, run, my_state)
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
