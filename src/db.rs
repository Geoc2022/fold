//! D1 query helpers.
//!
//! Counters on `activities` are kept authoritative by recomputing them from
//! `participations` on each mutation (`recompute_counts`). This reads only the
//! participations for a single activity (indexed) and happens on infrequent
//! writes, so it does not affect the polling read budget.

use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::models::{ActivityRow, NotificationRow, ParticipationLite, PersonRow};

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

const ACTIVITY_COLS: &str = "a.id, a.title, a.description, a.proposer_id, a.min_people, \
    a.max_people, a.group_multiple, a.grouping_mode, a.status, a.location, a.scheduled_for, \
    a.expires_at, a.interested_count, a.committed_count, a.created_at, a.updated_at, \
    p.handle AS proposer_handle";

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

// ---- push subscriptions ----------------------------------------------------

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
    .bind(&[s(&id), s(person_id), s(endpoint), s(p256dh), s(auth), i(now)])?
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

pub async fn committed_person_ids(
    db: &D1Database,
    activity_id: &str,
    exclude_person: Option<&str>,
) -> Result<Vec<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        person_id: String,
    }
    let recipients = db
        .prepare("SELECT person_id FROM participations WHERE activity_id = ? AND state = 'committed'")
        .bind(&[s(activity_id)])?
        .all()
        .await?
        .results::<Row>()?;
    Ok(recipients
        .into_iter()
        .map(|r| r.person_id)
        .filter(|id| Some(id.as_str()) != exclude_person)
        .collect())
}

// ---- activities ------------------------------------------------------------

pub async fn list_activities(db: &D1Database, limit: i64) -> Result<Vec<ActivityRow>> {
    let sql = format!(
        "SELECT {ACTIVITY_COLS} FROM activities a \
         LEFT JOIN people p ON p.id = a.proposer_id \
         ORDER BY a.created_at DESC LIMIT ?"
    );
    db.prepare(&sql).bind(&[i(limit)])?.all().await?.results::<ActivityRow>()
}

pub async fn get_activity(db: &D1Database, id: &str) -> Result<Option<ActivityRow>> {
    let sql = format!(
        "SELECT {ACTIVITY_COLS} FROM activities a \
         LEFT JOIN people p ON p.id = a.proposer_id WHERE a.id = ?"
    );
    db.prepare(&sql).bind(&[s(id)])?.first::<ActivityRow>(None).await
}

/// Recompute denormalized counts from participations and refresh `updated_at`.
pub async fn recompute_counts(db: &D1Database, activity_id: &str, now: i64) -> Result<()> {
    db.prepare(
        "UPDATE activities SET \
            interested_count = (SELECT COUNT(*) FROM participations WHERE activity_id = ?1 AND state = 'interested'), \
            committed_count  = (SELECT COUNT(*) FROM participations WHERE activity_id = ?1 AND state = 'committed'), \
            updated_at = ?2 \
         WHERE id = ?1",
    )
    .bind(&[s(activity_id), i(now)])?
    .run()
    .await?;
    Ok(())
}

pub async fn set_activity_status(
    db: &D1Database,
    activity_id: &str,
    status: &str,
    now: i64,
) -> Result<()> {
    db.prepare("UPDATE activities SET status = ?, updated_at = ? WHERE id = ?")
        .bind(&[s(status), i(now), s(activity_id)])?
        .run()
        .await?;
    Ok(())
}

// ---- participations --------------------------------------------------------

pub async fn participations_for_person(
    db: &D1Database,
    person_id: &str,
) -> Result<Vec<ParticipationLite>> {
    db.prepare("SELECT activity_id, state FROM participations WHERE person_id = ?")
        .bind(&[s(person_id)])?
        .all()
        .await?
        .results::<ParticipationLite>()
}

pub async fn participation_state(
    db: &D1Database,
    activity_id: &str,
    person_id: &str,
) -> Result<Option<String>> {
    let row = db
        .prepare("SELECT activity_id, state FROM participations WHERE activity_id = ? AND person_id = ?")
        .bind(&[s(activity_id), s(person_id)])?
        .first::<ParticipationLite>(None)
        .await?;
    Ok(row.map(|r| r.state))
}

/// Returns the id of another activity the person is committed to, if any.
pub async fn other_committed_activity(
    db: &D1Database,
    person_id: &str,
    exclude_activity_id: &str,
) -> Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Row {
        activity_id: String,
    }
    let row = db
        .prepare(
            "SELECT activity_id FROM participations \
             WHERE person_id = ? AND state = 'committed' AND activity_id != ? LIMIT 1",
        )
        .bind(&[s(person_id), s(exclude_activity_id)])?
        .first::<Row>(None)
        .await?;
    Ok(row.map(|r| r.activity_id))
}

pub async fn upsert_participation(
    db: &D1Database,
    activity_id: &str,
    person_id: &str,
    state: &str,
    now: i64,
) -> Result<()> {
    let id = crate::util::new_id();
    db.prepare(
        "INSERT INTO participations (id, activity_id, person_id, state, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
         ON CONFLICT(activity_id, person_id) DO UPDATE SET state = ?4, updated_at = ?5",
    )
    .bind(&[s(&id), s(activity_id), s(person_id), s(state), i(now)])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_participation(
    db: &D1Database,
    activity_id: &str,
    person_id: &str,
) -> Result<()> {
    db.prepare("DELETE FROM participations WHERE activity_id = ? AND person_id = ?")
        .bind(&[s(activity_id), s(person_id)])?
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
        "SELECT id, recipient_id, activity_id, kind, message, read_at, created_at \
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
    kind: &str,
    message: &str,
    now: i64,
) -> Result<()> {
    let id = crate::util::new_id();
    db.prepare(
        "INSERT INTO notifications (id, recipient_id, activity_id, kind, message, read_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
    )
    .bind(&[s(&id), s(recipient_id), os(activity_id), s(kind), s(message), i(now)])?
    .run()
    .await?;
    Ok(())
}

/// Notify every committed participant of an activity (optionally excluding one person).
pub async fn notify_committed(
    db: &D1Database,
    activity_id: &str,
    exclude_person: Option<&str>,
    kind: &str,
    message: &str,
    now: i64,
) -> Result<Vec<String>> {
    let recipients = committed_person_ids(db, activity_id, exclude_person).await?;

    let mut stmts = Vec::new();
    for person_id in &recipients {
        let id = crate::util::new_id();
        stmts.push(
            db.prepare(
                "INSERT INTO notifications (id, recipient_id, activity_id, kind, message, read_at, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            )
            .bind(&[s(&id), s(person_id), s(activity_id), s(kind), s(message), i(now)])?,
        );
    }
    if !stmts.is_empty() {
        db.batch(stmts).await?;
    }
    Ok(recipients)
}

/// Notify every person except one (broadcast, e.g. "new activity proposed").
pub async fn notify_all_except(
    db: &D1Database,
    exclude_person: &str,
    activity_id: Option<&str>,
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
                "INSERT INTO notifications (id, recipient_id, activity_id, kind, message, read_at, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            )
            .bind(&[s(&nid), s(&p.id), os(activity_id), s(kind), s(message), i(now)])?,
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
            db.prepare("UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL")
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

/// Minimal projection of an activity that has passed its expiry.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExpiringActivity {
    pub id: String,
    pub title: String,
}

/// Find activities whose `expires_at` has passed and are still active
/// (open/ready/scheduled). Bounded by `limit` to keep the cron run within
/// the free-plan subrequest budget.
pub async fn expiring_activities(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> Result<Vec<ExpiringActivity>> {
    db.prepare(
        "SELECT id, title FROM activities \
         WHERE expires_at IS NOT NULL AND expires_at <= ? \
           AND status IN ('open', 'ready', 'scheduled') \
         ORDER BY expires_at ASC LIMIT ?",
    )
    .bind(&[i(now), i(limit)])?
    .all()
    .await?
    .results::<ExpiringActivity>()
}

/// Mark the given activities as expired in a single batch.
pub async fn expire_activities(db: &D1Database, ids: &[String], now: i64) -> Result<()> {
    let mut stmts = Vec::new();
    for id in ids {
        stmts.push(
            db.prepare(
                "UPDATE activities SET status = 'closed', updated_at = ? \
                 WHERE id = ? AND status IN ('open', 'ready', 'scheduled')",
            )
            .bind(&[i(now), s(id)])?,
        );
    }
    if !stmts.is_empty() {
        db.batch(stmts).await?;
    }
    Ok(())
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
        db.prepare(
            "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?",
        )
        .bind(&[i(now - read_ttl_ms)])?,
        db.prepare("DELETE FROM notifications WHERE created_at < ?")
            .bind(&[i(now - hard_ttl_ms)])?,
    ])
    .await?;
    Ok(())
}
