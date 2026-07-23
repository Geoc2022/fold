//! Pure reconciliation for durable policy occurrences.
//!
//! Evaluation returns `None` for a no-op and a [`Timeline`] for every active
//! effect, including an effect containing only sleeps. The first active
//! evaluation, an inactive-to-active transition, or a rule version change
//! starts a new occurrence at `now_ms`. Re-evaluating the same active
//! occurrence keeps its original origin so sleeps do not slide forward.

use std::collections::BTreeSet;

use crate::policy_timeline::{PlannedAction, Timeline, TimelineAction};

/// Host-provided durable state for one policy instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceSnapshot {
    pub rule_version: i64,
    pub active: bool,
    pub occurrence: i64,
    pub origin_at_ms: Option<i64>,
}

/// The reconciliation-relevant state of a durable action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionStatus {
    Pending,
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// Host-independent representation of an action already stored durably.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionSnapshot {
    pub occurrence: i64,
    pub key: String,
    pub sequence_index: usize,
    pub due_at_ms: i64,
    pub action: TimelineAction,
    pub status: ActionStatus,
}

impl ActionSnapshot {
    fn pending(occurrence: i64, planned: PlannedAction) -> Self {
        Self {
            occurrence,
            key: planned.key,
            sequence_index: planned.sequence_index,
            due_at_ms: planned.execute_at_ms,
            action: planned.action,
            status: ActionStatus::Pending,
        }
    }

    fn has_plan(&self, planned: &PlannedAction) -> bool {
        self.key == planned.key
            && self.sequence_index == planned.sequence_index
            && self.due_at_ms == planned.execute_at_ms
            && self.action == planned.action
    }
}

/// All state needed for one reconciliation pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileInput {
    pub now_ms: i64,
    pub rule_version: i64,
    /// `None` means that evaluation produced a no-op. `Some`, even when its
    /// timeline has no observable entries, means the policy is active.
    pub evaluated: Option<Timeline>,
    pub instance: Option<InstanceSnapshot>,
    pub actions: Vec<ActionSnapshot>,
}

/// A durable action identity, used when pending work must be cancelled.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ActionRef {
    pub occurrence: i64,
    pub key: String,
}

/// A minimal durable action mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionChange {
    Insert(ActionSnapshot),
    /// Replace the plan and restore the status to `Pending`. This is emitted
    /// for changed pending actions and actions cancelled earlier in the same
    /// occurrence, but never for running, completed, or failed actions.
    Update(ActionSnapshot),
    Cancel(ActionRef),
}

/// The complete, transaction-ready result of reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    pub instance: InstanceSnapshot,
    pub action_changes: Vec<ActionChange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileError {
    OccurrenceOverflow,
    ActiveInstanceMissingOrigin,
}

/// Reconcile one evaluated policy against its durable instance and actions.
///
/// Completed actions are immutable within an occurrence. Pending actions may
/// be updated in place when their due time or payload changes, and are
/// cancelled when they disappear from the plan or the policy becomes inactive.
pub fn reconcile(input: ReconcileInput) -> Result<Reconciliation, ReconcileError> {
    let ReconcileInput {
        now_ms,
        rule_version,
        evaluated,
        instance,
        actions,
    } = input;

    let is_initial = instance.is_none();
    let previous = instance.unwrap_or(InstanceSnapshot {
        rule_version,
        active: false,
        occurrence: 0,
        origin_at_ms: None,
    });
    let active = evaluated.is_some();
    let starts_occurrence =
        active && (is_initial || !previous.active || previous.rule_version != rule_version);

    let (occurrence, origin_at_ms) = if starts_occurrence {
        (
            previous
                .occurrence
                .checked_add(1)
                .ok_or(ReconcileError::OccurrenceOverflow)?,
            Some(now_ms),
        )
    } else if active {
        (
            previous.occurrence,
            Some(
                previous
                    .origin_at_ms
                    .ok_or(ReconcileError::ActiveInstanceMissingOrigin)?,
            ),
        )
    } else {
        (previous.occurrence, None)
    };

    let instance = InstanceSnapshot {
        rule_version,
        active,
        occurrence,
        origin_at_ms,
    };
    let planned = evaluated
        .as_ref()
        .map(|timeline| timeline.plan(origin_at_ms.expect("active policies have an origin")))
        .unwrap_or_default();
    let desired_keys = planned
        .iter()
        .map(|action| action.key.as_str())
        .collect::<BTreeSet<_>>();

    // Cancel stale pending work first. Callers can apply changes in order and
    // safely use the same transaction for a version/occurrence transition.
    let mut cancellations = actions
        .iter()
        .filter(|action| {
            action.status == ActionStatus::Pending
                && (!active
                    || action.occurrence != occurrence
                    || !desired_keys.contains(action.key.as_str()))
        })
        .map(|action| ActionRef {
            occurrence: action.occurrence,
            key: action.key.clone(),
        })
        .collect::<Vec<_>>();
    cancellations.sort();

    let mut action_changes = cancellations
        .into_iter()
        .map(ActionChange::Cancel)
        .collect::<Vec<_>>();

    for plan in planned {
        let existing = actions
            .iter()
            .find(|action| action.occurrence == occurrence && action.key == plan.key);
        match existing {
            None => action_changes.push(ActionChange::Insert(ActionSnapshot::pending(
                occurrence, plan,
            ))),
            Some(action) if action.status == ActionStatus::Pending && !action.has_plan(&plan) => {
                action_changes.push(ActionChange::Update(ActionSnapshot::pending(
                    occurrence, plan,
                )));
            }
            Some(action) if action.status == ActionStatus::Cancelled => {
                action_changes.push(ActionChange::Update(ActionSnapshot::pending(
                    occurrence, plan,
                )));
            }
            Some(_) => {}
        }
    }

    Ok(Reconciliation {
        instance,
        action_changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy_timeline::{TimelineAction, TimelineEntry};

    fn notify(message: &str) -> TimelineAction {
        TimelineAction::Notify {
            message: message.to_string(),
        }
    }

    fn timeline(entries: Vec<(usize, Vec<usize>, i64, TimelineAction)>) -> Timeline {
        Timeline {
            total_offset_ms: entries.last().map(|(_, _, offset, _)| *offset).unwrap_or(0),
            entries: entries
                .into_iter()
                .map(|(sequence_index, path, offset_ms, action)| TimelineEntry {
                    sequence_index,
                    path,
                    offset_ms,
                    action,
                })
                .collect(),
        }
    }

    fn one_notify(offset_ms: i64, message: &str) -> Timeline {
        timeline(vec![(0, vec![1], offset_ms, notify(message))])
    }

    fn initial(now_ms: i64, evaluated: Option<Timeline>) -> Reconciliation {
        reconcile(ReconcileInput {
            now_ms,
            rule_version: 1,
            evaluated,
            instance: None,
            actions: vec![],
        })
        .unwrap()
    }

    fn inserted(result: &Reconciliation) -> Vec<ActionSnapshot> {
        result
            .action_changes
            .iter()
            .filter_map(|change| match change {
                ActionChange::Insert(action) => Some(action.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn initial_true_starts_occurrence_and_zero_offset_is_due_now() {
        let result = initial(42_000, Some(one_notify(0, "ready")));

        assert_eq!(
            result.instance,
            InstanceSnapshot {
                rule_version: 1,
                active: true,
                occurrence: 1,
                origin_at_ms: Some(42_000),
            }
        );
        let actions = inserted(&result);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].due_at_ms, 42_000);
        assert_eq!(actions[0].status, ActionStatus::Pending);
    }

    #[test]
    fn false_true_cycles_increment_occurrence_and_reset_origin() {
        let first = initial(1_000, Some(one_notify(0, "go")));
        let first_action = inserted(&first).remove(0);
        let inactive = reconcile(ReconcileInput {
            now_ms: 2_000,
            rule_version: 1,
            evaluated: None,
            instance: Some(first.instance),
            actions: vec![first_action.clone()],
        })
        .unwrap();

        assert!(!inactive.instance.active);
        assert_eq!(inactive.instance.occurrence, 1);
        assert_eq!(inactive.instance.origin_at_ms, None);
        assert_eq!(
            inactive.action_changes,
            vec![ActionChange::Cancel(ActionRef {
                occurrence: 1,
                key: first_action.key,
            })]
        );

        let second = reconcile(ReconcileInput {
            now_ms: 3_000,
            rule_version: 1,
            evaluated: Some(one_notify(0, "go")),
            instance: Some(inactive.instance),
            actions: vec![],
        })
        .unwrap();
        assert_eq!(second.instance.occurrence, 2);
        assert_eq!(second.instance.origin_at_ms, Some(3_000));
        assert_eq!(inserted(&second)[0].due_at_ms, 3_000);
    }

    #[test]
    fn same_active_plan_is_a_noop_and_preserves_origin() {
        let first = initial(10_000, Some(one_notify(20_000, "yo")));
        let existing = inserted(&first);
        let result = reconcile(ReconcileInput {
            now_ms: 25_000,
            rule_version: 1,
            evaluated: Some(one_notify(20_000, "yo")),
            instance: Some(first.instance),
            actions: existing,
        })
        .unwrap();

        assert_eq!(result.instance.origin_at_ms, Some(10_000));
        assert!(result.action_changes.is_empty());
    }

    #[test]
    fn changed_due_time_and_payload_update_pending_action() {
        let first = initial(10_000, Some(one_notify(20_000, "old")));
        let existing = inserted(&first);
        let result = reconcile(ReconcileInput {
            now_ms: 15_000,
            rule_version: 1,
            evaluated: Some(one_notify(7_000, "new")),
            instance: Some(first.instance),
            actions: existing,
        })
        .unwrap();

        assert_eq!(result.action_changes.len(), 1);
        let ActionChange::Update(action) = &result.action_changes[0] else {
            panic!("expected an update");
        };
        assert_eq!(action.due_at_ms, 17_000);
        assert_eq!(action.action, notify("new"));
    }

    #[test]
    fn false_and_removed_steps_cancel_only_pending_actions() {
        let first = initial(
            0,
            Some(timeline(vec![
                (0, vec![0], 0, notify("a")),
                (1, vec![1], 1_000, notify("b")),
            ])),
        );
        let mut actions = inserted(&first);
        actions[0].status = ActionStatus::Completed;

        let reduced = reconcile(ReconcileInput {
            now_ms: 500,
            rule_version: 1,
            evaluated: Some(timeline(vec![(0, vec![0], 0, notify("a"))])),
            instance: Some(first.instance.clone()),
            actions: actions.clone(),
        })
        .unwrap();
        assert!(matches!(
            reduced.action_changes.as_slice(),
            [ActionChange::Cancel(ActionRef { key, .. })] if key == "notify:1:1"
        ));

        actions[1].status = ActionStatus::Running;
        let inactive = reconcile(ReconcileInput {
            now_ms: 600,
            rule_version: 1,
            evaluated: None,
            instance: Some(first.instance),
            actions,
        })
        .unwrap();
        assert!(inactive.action_changes.is_empty());
    }

    #[test]
    fn completed_steps_never_repeat_but_later_pending_steps_can_change() {
        let first = initial(
            100,
            Some(timeline(vec![
                (0, vec![0], 0, notify("sent")),
                (1, vec![2], 20_000, notify("later")),
            ])),
        );
        let mut actions = inserted(&first);
        actions[0].status = ActionStatus::Completed;

        let result = reconcile(ReconcileInput {
            now_ms: 5_000,
            rule_version: 1,
            evaluated: Some(timeline(vec![
                (0, vec![0], 0, notify("do not resend")),
                (1, vec![2], 10_000, notify("updated")),
            ])),
            instance: Some(first.instance),
            actions,
        })
        .unwrap();

        assert_eq!(result.action_changes.len(), 1);
        let ActionChange::Update(action) = &result.action_changes[0] else {
            panic!("expected pending step update");
        };
        assert_eq!(action.sequence_index, 1);
        assert_eq!(action.due_at_ms, 10_100);
        assert_eq!(action.action, notify("updated"));
    }

    #[test]
    fn edit_to_new_version_is_a_new_occurrence() {
        let first = initial(1_000, Some(one_notify(0, "v1")));
        let mut old_action = inserted(&first).remove(0);
        old_action.status = ActionStatus::Completed;

        let edited = reconcile(ReconcileInput {
            now_ms: 9_000,
            rule_version: 2,
            evaluated: Some(one_notify(0, "v2")),
            instance: Some(first.instance),
            actions: vec![old_action],
        })
        .unwrap();

        assert_eq!(edited.instance.rule_version, 2);
        assert_eq!(edited.instance.occurrence, 2);
        assert_eq!(edited.instance.origin_at_ms, Some(9_000));
        let new_action = inserted(&edited).remove(0);
        assert_eq!(new_action.occurrence, 2);
        assert_eq!(new_action.due_at_ms, 9_000);
        assert_eq!(new_action.action, notify("v2"));
    }

    #[test]
    fn documented_twenty_second_timeline_does_not_slide_on_re_evaluation() {
        // `{ sleep 20s, notify "yo" }`
        let first = initial(1_000_000, Some(one_notify(20_000, "yo")));
        assert_eq!(inserted(&first)[0].due_at_ms, 1_020_000);

        let result = reconcile(ReconcileInput {
            now_ms: 1_015_000,
            rule_version: 1,
            evaluated: Some(one_notify(20_000, "yo")),
            instance: Some(first.instance.clone()),
            actions: inserted(&first),
        })
        .unwrap();
        assert_eq!(result.instance.origin_at_ms, Some(1_000_000));
        assert!(result.action_changes.is_empty());
    }

    #[test]
    fn documented_stress_timeline_uses_one_stable_origin() {
        let stress = timeline(vec![
            (0, vec![0], 0, notify("Quorum reached for Evening Match")),
            (1, vec![2], 180_000, notify("Starts in 2")),
            (2, vec![4], 195_000, notify("Last call")),
        ]);
        let first = initial(50_000, Some(stress.clone()));
        assert_eq!(
            inserted(&first)
                .iter()
                .map(|action| action.due_at_ms)
                .collect::<Vec<_>>(),
            vec![50_000, 230_000, 245_000]
        );

        let mut actions = inserted(&first);
        actions[0].status = ActionStatus::Completed;
        let repeated = reconcile(ReconcileInput {
            now_ms: 100_000,
            rule_version: 1,
            evaluated: Some(stress),
            instance: Some(first.instance),
            actions,
        })
        .unwrap();
        assert_eq!(repeated.instance.origin_at_ms, Some(50_000));
        assert!(repeated.action_changes.is_empty());
    }

    #[test]
    fn cancelled_step_can_return_but_terminal_and_in_flight_steps_do_not() {
        let first = initial(0, Some(one_notify(1_000, "a")));
        for status in [
            ActionStatus::Cancelled,
            ActionStatus::Running,
            ActionStatus::Completed,
            ActionStatus::Failed,
        ] {
            let mut action = inserted(&first).remove(0);
            action.status = status;
            let result = reconcile(ReconcileInput {
                now_ms: 10,
                rule_version: 1,
                evaluated: Some(one_notify(1_000, "a")),
                instance: Some(first.instance.clone()),
                actions: vec![action],
            })
            .unwrap();
            assert_eq!(
                !result.action_changes.is_empty(),
                status == ActionStatus::Cancelled
            );
        }
    }
}
