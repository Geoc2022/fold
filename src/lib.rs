pub mod logic;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub mod policy_env;
pub mod policy_planner;
pub mod policy_timeline;

#[cfg(target_arch = "wasm32")]
use worker::*;

#[cfg(target_arch = "wasm32")]
mod api;
#[cfg(target_arch = "wasm32")]
mod db;
#[cfg(target_arch = "wasm32")]
mod models;
#[cfg(target_arch = "wasm32")]
mod policy_runtime;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod policy_store;
#[cfg(target_arch = "wasm32")]
mod push;
#[cfg(target_arch = "wasm32")]
mod push_crypto;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
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
    if !util::request_is_same_origin(&req)? {
        return util::err_json("cross-origin mutation denied", 403);
    }
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
        .delete_async("/api/session", api::session_delete)
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
        // Revisioned personal policy sets.
        .get_async("/api/policies", api::policies_get)
        .put_async("/api/policies", api::policies_replace)
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
    if let Err(e) = policy_runtime::sweep(&env).await {
        console_error!("policy sweep failed: {e}");
    }
}

#[cfg(target_arch = "wasm32")]
#[event(queue)]
async fn queue(
    batch: MessageBatch<policy_runtime::PolicyJob>,
    env: Env,
    _ctx: Context,
) -> Result<()> {
    for message in batch.messages()? {
        match policy_runtime::process_job(&env, message.body()).await {
            Ok(()) => message.ack(),
            Err(error) => {
                console_error!("policy queue job failed: {error}");
                message.retry();
            }
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
async fn run_maintenance(env: &Env) -> Result<()> {
    const EXPIRE_BATCH: i64 = 20;
    const READ_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7 days
    const HARD_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days
                                                       // Cron backstop for the lazy on-read reaps in `room_get`/`run_commit`/
                                                       // `run_interest`: catches despondent (unreachable >5min, see
                                                       // `api::DESPONDENT_MS`) or event-over participations in rooms nobody is
                                                       // actively polling. Bounded to stay within the free-plan subrequest
                                                       // budget per 15-min tick, same pattern as EXPIRE_BATCH above.
    const REAP_BATCH: i64 = 40;

    let db = env.d1("DB")?;
    let now = util::now_ms();

    let reaped_run_ids = db::reap_global(&db, now, now - api::DESPONDENT_MS, REAP_BATCH).await?;
    for run_id in &reaped_run_ids {
        if let Some(run) = db::get_run(&db, run_id).await? {
            if let Some(activity) = db::get_activity(&db, &run.activity_id).await? {
                api::refresh_run(&db, run_id, &activity, now).await?;
                policy_runtime::emit_event(
                    env,
                    &db,
                    &activity.id,
                    Some(run_id),
                    "participation_reaped",
                    None,
                    0,
                )
                .await?;
            }
        }
    }

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
        policy_runtime::emit_event(
            env,
            &db,
            &r.activity_id,
            Some(&r.id),
            "run_expired",
            None,
            0,
        )
        .await?;
    }

    db::prune_notifications(&db, now, READ_TTL_MS, HARD_TTL_MS).await?;
    Ok(())
}
