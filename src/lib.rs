pub mod logic;

#[cfg(target_arch = "wasm32")]
use worker::*;

#[cfg(target_arch = "wasm32")]
mod api;
#[cfg(target_arch = "wasm32")]
mod db;
#[cfg(target_arch = "wasm32")]
mod models;
#[cfg(target_arch = "wasm32")]
mod push;
#[cfg(target_arch = "wasm32")]
mod util;

/// Worker entrypoint.
///
/// Routing model (see wrangler.jsonc):
/// - Static assets (the built SPA in `web/dist`) are served directly by
///   Cloudflare and are free/unlimited on the Workers Free plan.
/// - Only requests matching `run_worker_first = ["/api/*"]` reach this Worker
///   and count against the 100k/day request budget.
#[cfg(target_arch = "wasm32")]
#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    Router::new()
        .get("/api/health", |_req, _ctx| {
            Response::from_json(&serde_json::json!({ "status": "ok", "service": "fold" }))
        })
        // Combined poll endpoint (activities + my states + my notifications).
        .get_async("/api/sync", api::sync)
        // Session / identity.
        .post_async("/api/session", api::session_create)
        .get_async("/api/session", api::session_get)
        .patch_async("/api/session", api::session_update)
        // Activities (persistent tiles/templates).
        .post_async("/api/activities", api::activity_create)
        .get_async("/api/activities/:id", api::activity_get)
        .patch_async("/api/activities/:id", api::activity_update)
        .delete_async("/api/activities/:id", api::activity_delete)
        .post_async("/api/activities/:id/runs", api::activity_create_run)
        .get_async("/api/rooms/:code", api::room_get)
        // Participation (on the activity's current run).
        .post_async("/api/runs/:id/interest", api::run_interest)
        .post_async("/api/runs/:id/commit", api::run_commit)
        .delete_async("/api/runs/:id/participation", api::run_withdraw)
        // Proposer actions (on a run).
        .post_async("/api/runs/:id/schedule", api::run_schedule)
        .post_async("/api/runs/:id/close", api::run_close)
        .post_async("/api/runs/:id/cancel", api::run_cancel)
        // Notifications.
        .post_async("/api/notifications/read", api::notifications_read)
        // Web Push subscriptions.
        .get_async("/api/push/public-key", api::push_public_key)
        .post_async("/api/push/subscriptions", api::push_subscribe)
        .delete_async("/api/push/subscriptions", api::push_unsubscribe)
        .run(req, env)
        .await
}

/// Cron entrypoint (see `triggers.crons` in wrangler.jsonc).
///
/// Housekeeping to stay within the Workers Free plan:
///   - expire runs past their `expires_at` (notifying committed people and
///     rolling their final counts onto the activity's lifetime stats),
///   - prune old notifications so the table stays small.
/// Work is bounded per run to respect the 50-subrequest limit.
#[cfg(target_arch = "wasm32")]
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if let Err(e) = run_maintenance(&env).await {
        console_error!("maintenance failed: {e}");
    }
}

#[cfg(target_arch = "wasm32")]
async fn run_maintenance(env: &Env) -> Result<()> {
    const EXPIRE_BATCH: i64 = 20;
    const READ_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7 days
    const HARD_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days

    let db = env.d1("DB")?;
    let now = util::now_ms();

    let expiring = db::expiring_runs(&db, now, EXPIRE_BATCH).await?;
    for r in &expiring {
        if let Some(activity) = db::get_activity(&db, &r.activity_id).await? {
            let recipients = db::notify_committed(
                &db,
                &activity.id,
                &r.id,
                None,
                "activity_closed",
                &format!("\"{}\" expired", activity.title),
                now,
            )
            .await?;
            push::send_to_people(env, &db, &recipients).await?;
        }
        api::end_run(&db, &r.id, "closed", now).await?;
    }

    db::prune_notifications(&db, now, READ_TTL_MS, HARD_TTL_MS).await?;
    Ok(())
}
