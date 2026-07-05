//! HTTP handlers for the `/api/*` routes.

use worker::*;

use crate::db;
use crate::logic::{compute_group_state, GroupingMode};
use crate::models::*;
use crate::util::{err_json, json_status, new_id, now_ms, person_id, random_color};

const ACTIVITY_LIST_LIMIT: i64 = 100;
const NOTIFICATION_LIMIT: i64 = 50;

// ---- helpers ---------------------------------------------------------------

/// Recompute counts, reconcile open/ready status, and return the fresh row plus
/// whether it just transitioned into "ready".
async fn refresh_activity(
    db: &D1Database,
    activity_id: &str,
    now: i64,
) -> Result<(ActivityRow, bool)> {
    db::recompute_counts(db, activity_id, now).await?;
    let mut row = db::get_activity(db, activity_id)
        .await?
        .ok_or_else(|| Error::RustError("activity not found after update".into()))?;

    let gs = compute_group_state(
        GroupingMode::parse(&row.grouping_mode),
        row.min_people.max(0) as u32,
        row.max_people.map(|m| m.max(0) as u32),
        row.group_multiple.max(0) as u32,
        row.committed_count.max(0) as u32,
    );

    let mut newly_ready = false;
    if row.status == "open" && gs.is_ready {
        db::set_activity_status(db, activity_id, "ready", now).await?;
        row.status = "ready".to_string();
        newly_ready = true;
    } else if row.status == "ready" && !gs.is_ready {
        db::set_activity_status(db, activity_id, "open", now).await?;
        row.status = "open".to_string();
    }
    Ok((row, newly_ready))
}

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

// ---- session ---------------------------------------------------------------

pub async fn session_create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: CreateSession = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    let handle = body.handle.trim();
    if handle.is_empty() || handle.chars().count() > 40 {
        return err_json("handle must be 1-40 characters", 400);
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

// ---- activities ------------------------------------------------------------

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

    let now = now_ms();
    let id = new_id();
    db.prepare(
        "INSERT INTO activities \
         (id, title, description, proposer_id, min_people, max_people, group_multiple, \
          grouping_mode, status, location, scheduled_for, expires_at, \
          interested_count, committed_count, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10, ?11, 0, 0, ?12, ?12)",
    )
    .bind(&[
        db::s(&id),
        db::s(title),
        db::os(body.description.as_deref()),
        db::s(&proposer.id),
        db::i(body.min_people as i64),
        db::oi(body.max_people.map(|m| m as i64)),
        db::i(group_multiple as i64),
        db::s(grouping_mode),
        db::os(body.location.as_deref()),
        db::oi(body.scheduled_for),
        db::oi(body.expires_at),
        db::i(now),
    ])?
    .run()
    .await?;

    // Broadcast to everyone else so the activity is discoverable.
    let msg = format!("{} proposed \"{}\"", proposer.handle, title);
    db::notify_all_except(&db, &proposer.id, Some(&id), "activity_proposed", &msg, now).await?;

    let row = db::get_activity(&db, &id).await?.ok_or_else(|| Error::RustError("insert failed".into()))?;
    json_status(&ActivityView::from_row(row, None), 201)
}

pub async fn activity_get(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let id = ctx.param("id").cloned().unwrap_or_default();
    let row = match db::get_activity(&db, &id).await? {
        Some(r) => r,
        None => return err_json("activity not found", 404),
    };
    let my_state = match person_id(&req) {
        Some(pid) => db::participation_state(&db, &id, &pid).await?,
        None => None,
    };
    Response::from_json(&ActivityView::from_row(row, my_state))
}

// ---- participation ---------------------------------------------------------

pub async fn activity_interest(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    let activity = match db::get_activity(&db, &id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if !matches!(activity.status.as_str(), "open" | "ready" | "scheduled") {
        return err_json("activity is not accepting participants", 409);
    }

    let now = now_ms();
    db::upsert_participation(&db, &id, &person.id, "interested", now).await?;
    db::touch_person(&db, &person.id, now).await?;

    let (row, _newly_ready) = refresh_activity(&db, &id, now).await?;

    // Notify the proposer of new interest (unless they're the one interested).
    if activity.proposer_id != person.id {
        let msg = format!("{} is interested in \"{}\"", person.handle, row.title);
        db::insert_notification(&db, &activity.proposer_id, Some(&id), "interest_added", &msg, now).await?;
    }

    Response::from_json(&ActivityView::from_row(row, Some("interested".to_string())))
}

pub async fn activity_commit(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    let activity = match db::get_activity(&db, &id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if !matches!(activity.status.as_str(), "open" | "ready") {
        return err_json("activity is not accepting commitments", 409);
    }

    let current = db::participation_state(&db, &id, &person.id).await?;
    let already_committed = current.as_deref() == Some("committed");

    if !already_committed {
        // Exclusive commit: at most one committed activity per person.
        if let Some(other) = db::other_committed_activity(&db, &person.id, &id).await? {
            let body = serde_json::json!({
                "error": "already committed to another activity",
                "conflict_activity_id": other,
            });
            return json_status(&body, 409);
        }
        // Capacity check against max_people.
        if let Some(max) = activity.max_people {
            if activity.committed_count + 1 > max {
                return err_json("activity is full", 409);
            }
        }
    }

    let now = now_ms();
    db::upsert_participation(&db, &id, &person.id, "committed", now).await?;
    db::touch_person(&db, &person.id, now).await?;

    let (row, newly_ready) = refresh_activity(&db, &id, now).await?;

    if !already_committed && activity.proposer_id != person.id {
        let msg = format!("{} committed to \"{}\"", person.handle, row.title);
        db::insert_notification(&db, &activity.proposer_id, Some(&id), "commit_added", &msg, now).await?;
    }
    if newly_ready {
        let msg = format!("\"{}\" has enough people — it's on!", row.title);
        db::notify_committed(&db, &id, None, "activity_ready", &msg, now).await?;
        if activity.proposer_id != person.id {
            // proposer may not be committed; make sure they hear it too.
            db::insert_notification(&db, &activity.proposer_id, Some(&id), "activity_ready", &msg, now).await?;
        }
    }

    Response::from_json(&ActivityView::from_row(row, Some("committed".to_string())))
}

pub async fn activity_withdraw(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, &req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    if db::get_activity(&db, &id).await?.is_none() {
        return err_json("activity not found", 404);
    }

    let now = now_ms();
    db::delete_participation(&db, &id, &person.id).await?;
    db::touch_person(&db, &person.id, now).await?;

    let (row, _) = refresh_activity(&db, &id, now).await?;
    Response::from_json(&ActivityView::from_row(row, None))
}

// ---- proposer actions ------------------------------------------------------

async fn proposer_action(
    req: &Request,
    ctx: &RouteContext<()>,
    new_status: &str,
    schedule: Option<ScheduleActivity>,
    notify_kind: &str,
) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let person = match require_person(&db, req).await? {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = ctx.param("id").cloned().unwrap_or_default();
    let activity = match db::get_activity(&db, &id).await? {
        Some(a) => a,
        None => return err_json("activity not found", 404),
    };
    if activity.proposer_id != person.id {
        return err_json("only the proposer can do that", 403);
    }

    let now = now_ms();
    match &schedule {
        Some(sched) => {
            db.prepare(
                "UPDATE activities SET status = ?, scheduled_for = ?, location = COALESCE(?, location), updated_at = ? WHERE id = ?",
            )
            .bind(&[
                db::s(new_status),
                db::i(sched.scheduled_for),
                db::os(sched.location.as_deref()),
                db::i(now),
                db::s(&id),
            ])?
            .run()
            .await?;
        }
        None => {
            db::set_activity_status(&db, &id, new_status, now).await?;
        }
    }

    let msg = match new_status {
        "scheduled" => format!("\"{}\" is scheduled", activity.title),
        "cancelled" => format!("\"{}\" was cancelled", activity.title),
        "closed" => format!("\"{}\" was closed", activity.title),
        _ => format!("\"{}\" was updated", activity.title),
    };
    db::notify_committed(&db, &id, Some(&person.id), notify_kind, &msg, now).await?;

    let row = db::get_activity(&db, &id).await?.ok_or_else(|| Error::RustError("missing".into()))?;
    let my_state = db::participation_state(&db, &id, &person.id).await?;
    Response::from_json(&ActivityView::from_row(row, my_state))
}

pub async fn activity_schedule(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let sched: ScheduleActivity = match req.json().await {
        Ok(b) => b,
        Err(_) => return err_json("invalid JSON body", 400),
    };
    proposer_action(&req, &ctx, "scheduled", Some(sched), "activity_scheduled").await
}

pub async fn activity_close(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    proposer_action(&req, &ctx, "closed", None, "activity_closed").await
}

pub async fn activity_cancel(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    proposer_action(&req, &ctx, "cancelled", None, "activity_cancelled").await
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

// ---- sync ------------------------------------------------------------------

pub async fn sync(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let db = ctx.env.d1("DB")?;
    let now = now_ms();

    let me_id = person_id(&req);
    let me = match &me_id {
        Some(pid) => db::get_person(&db, pid).await?,
        None => None,
    };

    let activities = db::list_activities(&db, ACTIVITY_LIST_LIMIT).await?;

    // Map of activity_id -> my participation state.
    let (my_states, notifications) = match &me {
        Some(p) => {
            let parts = db::participations_for_person(&db, &p.id).await?;
            let map: std::collections::HashMap<String, String> =
                parts.into_iter().map(|x| (x.activity_id, x.state)).collect();
            let notifs = db::unread_notifications(&db, &p.id, NOTIFICATION_LIMIT).await?;
            (map, notifs)
        }
        None => (std::collections::HashMap::new(), Vec::new()),
    };

    let views: Vec<ActivityView> = activities
        .into_iter()
        .map(|row| {
            let my_state = my_states.get(&row.id).cloned();
            ActivityView::from_row(row, my_state)
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
