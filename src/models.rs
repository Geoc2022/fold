//! Data structures: D1 row shapes, request inputs, and API response views.

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
    pub title: String,
    pub description: Option<String>,
    pub proposer_id: String,
    pub min_people: i64,
    pub max_people: Option<i64>,
    pub group_multiple: i64,
    pub grouping_mode: String,
    pub status: String,
    pub location: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
    pub interested_count: i64,
    pub committed_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Populated only by list/detail queries that JOIN the proposer.
    #[serde(default)]
    pub proposer_handle: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NotificationRow {
    pub id: String,
    pub recipient_id: String,
    pub activity_id: Option<String>,
    pub kind: String,
    pub message: String,
    pub read_at: Option<i64>,
    pub created_at: i64,
}

/// Minimal projection of a participation row.
#[derive(Debug, Clone, Deserialize)]
pub struct ParticipationLite {
    pub activity_id: String,
    pub state: String,
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

#[derive(Debug, Deserialize)]
pub struct CreateActivity {
    pub title: String,
    pub description: Option<String>,
    pub min_people: u32,
    pub max_people: Option<u32>,
    pub group_multiple: Option<u32>,
    pub grouping_mode: Option<String>,
    pub location: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ScheduleActivity {
    pub scheduled_for: i64,
    pub location: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MarkRead {
    /// Specific notification ids to mark read. When omitted, mark all as read.
    pub ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct PushSubscribe {
    pub endpoint: String,
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
pub struct ActivityView {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub proposer_id: String,
    pub proposer_handle: Option<String>,
    pub min_people: i64,
    pub max_people: Option<i64>,
    pub group_multiple: i64,
    pub grouping_mode: String,
    pub status: String,
    pub location: Option<String>,
    pub scheduled_for: Option<i64>,
    pub expires_at: Option<i64>,
    pub interested_count: i64,
    pub committed_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub group: GroupState,
    /// The requesting person's state for this activity: interested | committed | null.
    pub my_state: Option<String>,
}

impl ActivityView {
    pub fn from_row(row: ActivityRow, my_state: Option<String>) -> ActivityView {
        let group = compute_group_state(
            GroupingMode::parse(&row.grouping_mode),
            row.min_people.max(0) as u32,
            row.max_people.map(|m| m.max(0) as u32),
            row.group_multiple.max(0) as u32,
            row.committed_count.max(0) as u32,
        );
        ActivityView {
            id: row.id,
            title: row.title,
            description: row.description,
            proposer_id: row.proposer_id,
            proposer_handle: row.proposer_handle,
            min_people: row.min_people,
            max_people: row.max_people,
            group_multiple: row.group_multiple,
            grouping_mode: row.grouping_mode,
            status: row.status,
            location: row.location,
            scheduled_for: row.scheduled_for,
            expires_at: row.expires_at,
            interested_count: row.interested_count,
            committed_count: row.committed_count,
            created_at: row.created_at,
            updated_at: row.updated_at,
            group,
            my_state,
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
