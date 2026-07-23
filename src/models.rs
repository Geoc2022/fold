//! Data structures: D1 row shapes, request inputs, and API response views.
//!
//! Activities are persistent templates/tiles (title, emoji, category, stable
//! room code, grouping shape, lifetime stats). Each gathering is a `Run`
//! (time/location/status/participants) that belongs to an activity. At most
//! one run per activity is "current" (`activities.current_run_id`); when it
//! ends, its stats roll up onto the activity and the room goes back to
//! "empty" (prompting a new proposal).

use serde::{Deserialize, Serialize};

use crate::logic::{compute_group_state, GroupState, GroupingMode};

// ---- DB rows ---------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PersonRow {
    pub id: String,
    pub handle: String,
    pub color: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityRow {
    pub id: String,
    pub code: String,
    pub emoji: String,
    pub title: String,
    pub description: Option<String>,
    pub category: String,
    pub proposer_id: String,
    pub min_people: i64,
    pub max_people: Option<i64>,
    pub group_multiple: i64,
    pub grouping_mode: String,
    pub allow_guests: i64,
    pub private_by_link: i64,
    pub duration_seconds: i64,
    pub max_commit_seconds: i64,
    pub current_run_id: Option<String>,
    pub times_run: i64,
    pub players_served: i64,
    pub interest_total: i64,
    pub commit_total: i64,
    pub last_active_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Populated only by queries that JOIN the proposer.
    #[serde(default)]
    pub proposer_handle: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunRow {
    pub id: String,
    pub activity_id: String,
    pub status: String,
    pub location: Option<String>,
    pub details: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
    pub interested_count: i64,
    pub committed_count: i64,
    pub reached_ready: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NotificationRow {
    pub id: String,
    pub recipient_id: String,
    pub activity_id: Option<String>,
    pub run_id: Option<String>,
    pub kind: String,
    pub message: String,
    pub read_at: Option<i64>,
    pub created_at: i64,
}

/// Minimal projection of a participation row.
#[derive(Debug, Clone, Deserialize)]
pub struct ParticipationLite {
    pub run_id: String,
    pub state: String,
    pub arrival_at: Option<i64>,
}

// ---- Request inputs --------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateSession {
    pub handle: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSession {
    pub handle: Option<String>,
    pub color: Option<String>,
}

/// Creates a new activity (tile) plus its first run in one call.
#[derive(Debug, Deserialize)]
pub struct CreateActivity {
    pub code: Option<String>,
    pub emoji: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub min_people: u32,
    pub max_people: Option<u32>,
    pub group_multiple: Option<u32>,
    pub grouping_mode: Option<String>,
    pub allow_guests: Option<bool>,
    pub private_by_link: Option<bool>,
    pub duration_seconds: Option<u32>,
    pub max_commit_seconds: Option<u32>,
    // First-run fields.
    pub location: Option<String>,
    pub details: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
}

/// Creates a new run on an existing activity whose room is currently empty
/// (no active run). Grouping/code/emoji are inherited from the activity.
#[derive(Debug, Deserialize)]
pub struct CreateRun {
    pub location: Option<String>,
    pub details: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
}

/// Updates an existing activity template.
#[derive(Debug, Deserialize)]
pub struct UpdateActivity {
    pub emoji: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub min_people: u32,
    pub max_people: Option<u32>,
    pub group_multiple: Option<u32>,
    pub grouping_mode: Option<String>,
    pub allow_guests: Option<bool>,
    pub private_by_link: Option<bool>,
    pub duration_seconds: Option<u32>,
    pub max_commit_seconds: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct ScheduleRun {
    pub scheduled_for: i64,
    pub location: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CommitRun {
    /// Seconds from now until the participant can make it. Clamped to
    /// 0..=activity.max_commit_seconds.
    pub eta_seconds: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct MarkRead {
    /// Specific notification ids to mark read. When omitted, mark all as read.
    pub ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct PushSubscribe {
    pub endpoint: String,
    #[serde(default, rename = "expirationTime")]
    pub expiration_time: Option<i64>,
    pub keys: PushKeys,
}

#[derive(Debug, Deserialize)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize)]
pub struct PushUnsubscribe {
    pub endpoint: String,
}

// ---- API views -------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RunView {
    pub id: String,
    pub status: String,
    pub location: Option<String>,
    pub details: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
    pub interested_count: i64,
    pub committed_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub group: GroupState,
}

impl RunView {
    pub fn from_row(row: RunRow, activity: &ActivityRow) -> RunView {
        let group = compute_group_state(
            GroupingMode::parse(&activity.grouping_mode),
            activity.min_people.max(0) as u32,
            activity.max_people.map(|m| m.max(0) as u32),
            activity.group_multiple.max(0) as u32,
            row.committed_count.max(0) as u32,
        );
        RunView {
            id: row.id,
            status: row.status,
            location: row.location,
            details: row.details,
            scheduled_for: row.scheduled_for,
            expires_at: row.expires_at,
            interested_count: row.interested_count,
            committed_count: row.committed_count,
            created_at: row.created_at,
            updated_at: row.updated_at,
            group,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ActivityView {
    pub id: String,
    pub code: String,
    pub emoji: String,
    pub title: String,
    pub description: Option<String>,
    pub category: String,
    pub proposer_id: String,
    pub proposer_handle: Option<String>,
    pub min_people: i64,
    pub max_people: Option<i64>,
    pub group_multiple: i64,
    pub grouping_mode: String,
    pub allow_guests: bool,
    pub private_by_link: bool,
    pub duration_seconds: i64,
    pub max_commit_seconds: i64,
    pub times_run: i64,
    pub players_served: i64,
    pub interest_total: i64,
    pub commit_total: i64,
    /// commit_total / (interest_total + commit_total), or null if nobody has
    /// ever participated yet.
    pub commit_pct: Option<f64>,
    pub last_active_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// The active/open run, if the room isn't currently empty.
    pub current_run: Option<RunView>,
    /// The requesting person's state in the current run: interested | committed | null.
    pub my_state: Option<String>,
    /// If `my_state` is committed, this is that commitment's ETA timestamp.
    pub my_arrival_at: Option<i64>,
}

impl ActivityView {
    pub fn from_row(
        row: ActivityRow,
        current_run: Option<RunRow>,
        my_state: Option<String>,
        my_arrival_at: Option<i64>,
    ) -> ActivityView {
        let commit_pct = {
            let total = row.interest_total + row.commit_total;
            if total > 0 {
                Some(row.commit_total as f64 / total as f64)
            } else {
                None
            }
        };
        let current_run_view = current_run.map(|r| RunView::from_row(r, &row));
        ActivityView {
            id: row.id,
            code: row.code,
            emoji: row.emoji,
            title: row.title,
            description: row.description,
            category: row.category,
            proposer_id: row.proposer_id,
            proposer_handle: row.proposer_handle,
            min_people: row.min_people,
            max_people: row.max_people,
            group_multiple: row.group_multiple,
            grouping_mode: row.grouping_mode,
            allow_guests: row.allow_guests != 0,
            private_by_link: row.private_by_link != 0,
            duration_seconds: row.duration_seconds,
            max_commit_seconds: row.max_commit_seconds,
            times_run: row.times_run,
            players_served: row.players_served,
            interest_total: row.interest_total,
            commit_total: row.commit_total,
            commit_pct,
            last_active_at: row.last_active_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            current_run: current_run_view,
            my_state,
            my_arrival_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SyncResponse {
    pub server_time: i64,
    pub me: Option<PersonRow>,
    pub activities: Vec<ActivityView>,
    pub notifications: Vec<NotificationRow>,
}

#[derive(Debug, Serialize)]
pub struct ParticipantView {
    /// Opaque node id for client animation continuity. This is the participation
    /// row id, not the person's id.
    pub id: String,
    pub color: String,
    pub state: String,
    pub arrival_at: Option<i64>,
    pub is_me: bool,
    /// This participant's `people.last_seen_at`, so the client can derive a
    /// "reachable" / "unreachable" (dimmed) visual tier itself, the same way
    /// it already derives `arrived` from `arrival_at` -- kept as a raw
    /// timestamp rather than a precomputed bool to avoid baking a threshold
    /// into the API and to sidestep server/client clock-skew questions
    /// (compared the same way `arrival_at` already is: against the
    /// client's own `Date.now()`).
    pub last_seen_at: i64,
}

#[derive(Debug, Serialize)]
pub struct RoomResponse {
    pub server_time: i64,
    pub activity: ActivityView,
    pub participants: Vec<ParticipantView>,
    /// True if the requesting person is already committed to a *different*
    /// run elsewhere -- lets the client block promoting to committed here
    /// before even trying (commit is exclusive: at most one at a time).
    pub already_committed_elsewhere: bool,
    /// The other activity room code where the requester is currently committed.
    pub other_committed_room_code: Option<String>,
    /// Title of the other activity room where the requester is currently committed.
    pub other_committed_activity_title: Option<String>,
}
