//! Host-independent flattening and planning for evaluated policy effects.
//!
//! A timeline contains only externally observable actions. `Sleep` effects
//! advance the cumulative offset, while `Seq` effects preserve evaluation
//! order and contribute their child indexes to each action's structural path.

use policy::eval::Effect;
use serde::{Deserialize, Serialize};

const MILLIS_PER_SECOND: i64 = 1_000;

/// An action a host must eventually apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TimelineAction {
    Notify {
        message: String,
    },
    SetState {
        state: String,
        eta_delta_secs: Option<i64>,
    },
}

impl TimelineAction {
    fn key_prefix(&self) -> &'static str {
        match self {
            Self::Notify { .. } => "notify",
            Self::SetState { .. } => "state",
        }
    }
}

/// One observable action in evaluation order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineEntry {
    /// Zero-based index among all observable actions, including state actions.
    pub sequence_index: usize,
    /// Child indexes followed through nested `Effect::Seq` values.
    /// A non-sequence root action has an empty path.
    pub path: Vec<usize>,
    /// Cumulative delay from all preceding sleeps.
    pub offset_ms: i64,
    pub action: TimelineAction,
}

impl TimelineEntry {
    /// Stable identity for reconciling repeated evaluations of the same effect
    /// shape. Payload and offset are deliberately excluded so an existing
    /// durable plan can be updated in place.
    pub fn key(&self) -> String {
        action_key(self.sequence_index, &self.path, self.action.key_prefix())
    }

    /// Convert this relative entry into an absolute time without overflowing.
    pub fn scheduled_at_ms(&self, origin_ms: i64) -> i64 {
        origin_ms.saturating_add(self.offset_ms)
    }
}

/// A flattened effect program and the cumulative delay after its final step.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Timeline {
    pub entries: Vec<TimelineEntry>,
    pub total_offset_ms: i64,
}

impl Timeline {
    /// Materialize absolute actions suitable for durable storage and keyed
    /// reconciliation.
    pub fn plan(&self, origin_ms: i64) -> Vec<PlannedAction> {
        self.entries
            .iter()
            .map(|entry| PlannedAction {
                key: entry.key(),
                sequence_index: entry.sequence_index,
                path: entry.path.clone(),
                execute_at_ms: entry.scheduled_at_ms(origin_ms),
                action: entry.action.clone(),
            })
            .collect()
    }
}

/// An absolute action produced for a durable scheduler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedAction {
    pub key: String,
    pub sequence_index: usize,
    pub path: Vec<usize>,
    pub execute_at_ms: i64,
    pub action: TimelineAction,
}

impl PlannedAction {
    pub fn is_due(&self, now_ms: i64) -> bool {
        self.execute_at_ms <= now_ms
    }
}

/// Flatten an evaluated effect into observable actions at cumulative offsets.
pub fn collect_timeline(effect: &Effect) -> Timeline {
    let mut entries = Vec::new();
    let mut path = Vec::new();
    let total_offset_ms = walk(effect, 0, &mut path, &mut entries);
    Timeline {
        entries,
        total_offset_ms,
    }
}

/// Flatten and convert an effect directly into absolute planned actions.
pub fn plan(effect: &Effect, origin_ms: i64) -> Vec<PlannedAction> {
    collect_timeline(effect).plan(origin_ms)
}

fn walk(
    effect: &Effect,
    offset_ms: i64,
    path: &mut Vec<usize>,
    entries: &mut Vec<TimelineEntry>,
) -> i64 {
    match effect {
        Effect::Notify { message } => {
            push_entry(
                entries,
                path,
                offset_ms,
                TimelineAction::Notify {
                    message: message.clone(),
                },
            );
            offset_ms
        }
        Effect::SetState {
            state,
            eta_delta_secs,
        } => {
            push_entry(
                entries,
                path,
                offset_ms,
                TimelineAction::SetState {
                    state: state.clone(),
                    eta_delta_secs: *eta_delta_secs,
                },
            );
            offset_ms
        }
        Effect::Sleep { secs } => offset_ms.saturating_add(sleep_ms(*secs)),
        Effect::Seq { steps } => {
            let mut current = offset_ms;
            for (index, step) in steps.iter().enumerate() {
                path.push(index);
                current = walk(step, current, path, entries);
                path.pop();
            }
            current
        }
        Effect::Noop => offset_ms,
    }
}

fn push_entry(
    entries: &mut Vec<TimelineEntry>,
    path: &[usize],
    offset_ms: i64,
    action: TimelineAction,
) {
    entries.push(TimelineEntry {
        sequence_index: entries.len(),
        path: path.to_vec(),
        offset_ms,
        action,
    });
}

fn sleep_ms(secs: i64) -> i64 {
    secs.max(0).saturating_mul(MILLIS_PER_SECOND)
}

fn action_key(sequence_index: usize, path: &[usize], kind: &str) -> String {
    let path = if path.is_empty() {
        "root".to_string()
    } else {
        path.iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(".")
    };
    format!("{kind}:{sequence_index}:{path}")
}

/// Notification-only projection retained for delivery loops.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueNotify {
    /// Index among all observable actions, not just notifications.
    pub event_index: usize,
    pub path: Vec<usize>,
    pub offset_ms: i64,
    pub message: String,
}

/// State-only projection for hosts that apply state and notification actions
/// through separate durable queues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueState {
    /// Index among all observable actions, not just state changes.
    pub event_index: usize,
    pub path: Vec<usize>,
    pub offset_ms: i64,
    pub state: String,
    pub eta_delta_secs: Option<i64>,
}

pub fn collect_notifies(effect: &Effect) -> Vec<DueNotify> {
    collect_timeline(effect)
        .entries
        .into_iter()
        .filter_map(|entry| match entry.action {
            TimelineAction::Notify { message } => Some(DueNotify {
                event_index: entry.sequence_index,
                path: entry.path,
                offset_ms: entry.offset_ms,
                message,
            }),
            TimelineAction::SetState { .. } => None,
        })
        .collect()
}

pub fn collect_states(effect: &Effect) -> Vec<DueState> {
    collect_timeline(effect)
        .entries
        .into_iter()
        .filter_map(|entry| match entry.action {
            TimelineAction::SetState {
                state,
                eta_delta_secs,
            } => Some(DueState {
                event_index: entry.sequence_index,
                path: entry.path,
                offset_ms: entry.offset_ms,
                state,
                eta_delta_secs,
            }),
            TimelineAction::Notify { .. } => None,
        })
        .collect()
}

/// Deterministic reconciliation key for a notification action.
pub fn event_key(event: &DueNotify) -> String {
    action_key(event.event_index, &event.path, "notify")
}

/// Deterministic reconciliation key for a state action.
pub fn state_event_key(event: &DueState) -> String {
    action_key(event.event_index, &event.path, "state")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notify(message: &str) -> Effect {
        Effect::Notify {
            message: message.to_string(),
        }
    }

    fn state(state: &str, eta_delta_secs: Option<i64>) -> Effect {
        Effect::SetState {
            state: state.to_string(),
            eta_delta_secs,
        }
    }

    #[test]
    fn matches_documented_stress_timeline() {
        let effect = Effect::Seq {
            steps: vec![
                notify("Quorum reached for Evening Match"),
                Effect::Sleep { secs: 180 },
                notify("Starts in 2"),
                Effect::Sleep { secs: 15 },
                notify("Last call"),
            ],
        };

        let timeline = collect_timeline(&effect);
        assert_eq!(timeline.total_offset_ms, 195_000);
        assert_eq!(
            timeline
                .entries
                .iter()
                .map(|entry| (entry.sequence_index, entry.path.clone(), entry.offset_ms))
                .collect::<Vec<_>>(),
            vec![
                (0, vec![0], 0),
                (1, vec![2], 180_000),
                (2, vec![4], 195_000),
            ]
        );
    }

    #[test]
    fn pickup_state_precedes_delayed_notify() {
        let effect = Effect::Seq {
            steps: vec![
                state("committed", Some(-300)),
                Effect::Seq {
                    steps: vec![
                        Effect::Sleep { secs: 300 },
                        notify("Warm up. We'll be starting in 5"),
                    ],
                },
            ],
        };

        let timeline = collect_timeline(&effect);
        assert_eq!(
            timeline.entries,
            vec![
                TimelineEntry {
                    sequence_index: 0,
                    path: vec![0],
                    offset_ms: 0,
                    action: TimelineAction::SetState {
                        state: "committed".to_string(),
                        eta_delta_secs: Some(-300),
                    },
                },
                TimelineEntry {
                    sequence_index: 1,
                    path: vec![1, 1],
                    offset_ms: 300_000,
                    action: TimelineAction::Notify {
                        message: "Warm up. We'll be starting in 5".to_string(),
                    },
                },
            ]
        );
        assert_eq!(collect_states(&effect)[0].event_index, 0);
        assert_eq!(collect_notifies(&effect)[0].event_index, 1);
    }

    #[test]
    fn nested_sequences_accumulate_sleeps_and_preserve_equal_time_order() {
        let effect = Effect::Seq {
            steps: vec![
                Effect::Sleep { secs: 2 },
                Effect::Seq {
                    steps: vec![
                        notify("a"),
                        Effect::Sleep { secs: -9 },
                        Effect::Noop,
                        state("interested", None),
                    ],
                },
                Effect::Sleep { secs: 3 },
                notify("b"),
            ],
        };

        let timeline = collect_timeline(&effect);
        assert_eq!(timeline.total_offset_ms, 5_000);
        assert_eq!(
            timeline
                .entries
                .iter()
                .map(|entry| (entry.sequence_index, entry.path.clone(), entry.offset_ms))
                .collect::<Vec<_>>(),
            vec![
                (0, vec![1, 0], 2_000),
                (1, vec![1, 3], 2_000),
                (2, vec![3], 5_000),
            ]
        );
    }

    #[test]
    fn negative_and_overlarge_sleeps_are_safe() {
        let negative = Effect::Seq {
            steps: vec![Effect::Sleep { secs: i64::MIN }, notify("now")],
        };
        assert_eq!(collect_timeline(&negative).entries[0].offset_ms, 0);

        let overlarge = Effect::Seq {
            steps: vec![Effect::Sleep { secs: i64::MAX }, notify("eventually")],
        };
        let timeline = collect_timeline(&overlarge);
        assert_eq!(timeline.total_offset_ms, i64::MAX);
        assert_eq!(timeline.entries[0].offset_ms, i64::MAX);
    }

    #[test]
    fn plans_have_stable_keys_and_saturating_absolute_times() {
        let first = Effect::Seq {
            steps: vec![
                Effect::Sleep { secs: 1 },
                notify("old payload"),
                state("arrived", None),
            ],
        };
        let second = Effect::Seq {
            steps: vec![
                Effect::Sleep { secs: 1 },
                notify("new payload"),
                state("arrived", Some(30)),
            ],
        };

        let first_plan = plan(&first, i64::MAX);
        let second_plan = plan(&second, i64::MAX);
        assert_eq!(first_plan[0].key, "notify:0:1");
        assert_eq!(first_plan[1].key, "state:1:2");
        assert_eq!(first_plan[0].key, second_plan[0].key);
        assert_eq!(first_plan[1].key, second_plan[1].key);
        assert_eq!(first_plan[0].execute_at_ms, i64::MAX);
        assert!(first_plan[0].is_due(i64::MAX));
    }

    #[test]
    fn projection_keys_match_general_timeline_keys() {
        let effect = Effect::Seq {
            steps: vec![state("interested", None), notify("hello")],
        };
        let timeline = collect_timeline(&effect);
        let state = collect_states(&effect).remove(0);
        let notification = collect_notifies(&effect).remove(0);

        assert_eq!(state_event_key(&state), timeline.entries[0].key());
        assert_eq!(event_key(&notification), timeline.entries[1].key());
    }

    #[test]
    fn root_action_has_an_unambiguous_path_key() {
        let timeline = collect_timeline(&notify("hello"));
        assert_eq!(timeline.entries[0].path, Vec::<usize>::new());
        assert_eq!(timeline.entries[0].key(), "notify:0:root");
    }
}
