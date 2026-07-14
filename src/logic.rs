//! Pure group/readiness logic for activities.
//!
//! This module has no dependency on the Worker runtime or D1 so it can be
//! unit-tested with plain `cargo test`.
//!
//! Two grouping shapes are supported:
//! - `Single`  : one elastic group in `[min, max]`, sizes stepped by
//!               `group_multiple` (e.g. Blood on the Clocktower, frisbee).
//!               Commits past `max` are rejected at the API layer.
//! - `Tiling`  : parallel fixed-size groups of `group_multiple` people each
//!               (e.g. badminton). Unlimited groups unless `max` caps the total.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupingMode {
    Single,
    Tiling,
}

impl GroupingMode {
    pub fn parse(s: &str) -> GroupingMode {
        match s {
            "tiling" => GroupingMode::Tiling,
            _ => GroupingMode::Single,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            GroupingMode::Single => "single",
            GroupingMode::Tiling => "tiling",
        }
    }
}

/// Derived state describing how the committed people form playable group(s).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupState {
    /// Number of complete, playable groups.
    pub complete_groups: u32,
    /// Size of each complete group (len == `complete_groups`).
    pub group_sizes: Vec<u32>,
    /// At least one complete group has formed.
    pub is_ready: bool,
    /// Committed people not placed into a complete group ("waiting to link up").
    pub waiting_count: u32,
    /// How many more commits to form the next group / grow to the next valid
    /// size. `None` when the activity is capped/full and cannot grow.
    pub spots_to_next: Option<u32>,
    /// Remaining commit capacity before hitting `max_people`. `None` if unlimited.
    pub spots_remaining: Option<u32>,
}

/// Whether a grouping configuration (min/max/step) can *ever* produce a
/// complete group, independent of the current committed count. Used to
/// reject nonsensical activity configs at creation time (e.g. tiling groups
/// of 4 capped at a max of 3 people can never form a single group), and
/// mirrored by the client-side group-size preview.
pub fn grouping_is_feasible(
    mode: GroupingMode,
    min_people: u32,
    max_people: Option<u32>,
    group_multiple: u32,
) -> bool {
    let min = min_people.max(1);
    let step = group_multiple.max(1);
    match mode {
        // Single mode just needs the floor (min) to fit under the cap.
        GroupingMode::Single => max_people.is_none_or(|cap| min <= cap),
        // Tiling groups only ever form in multiples of `step`, so min (and
        // max, if capped) must themselves be clean multiples of it --
        // otherwise people are structurally guaranteed to be left waiting
        // outside a group. Beyond that, at least `step` committed people
        // (and at least `min`) must fit under the cap for a group to ever
        // complete.
        GroupingMode::Tiling => {
            if min % step != 0 {
                return false;
            }
            if let Some(cap) = max_people {
                if cap % step != 0 {
                    return false;
                }
            }
            let needed = min.max(step);
            max_people.is_none_or(|cap| needed <= cap)
        }
    }
}

/// Compute the group state for an activity from its (denormalized) committed count.
pub fn compute_group_state(
    mode: GroupingMode,
    min_people: u32,
    max_people: Option<u32>,
    group_multiple: u32,
    committed: u32,
) -> GroupState {
    let step = group_multiple.max(1);
    let min = min_people.max(1);
    match mode {
        GroupingMode::Single => single(min, max_people, step, committed),
        GroupingMode::Tiling => tiling(min, max_people, step, committed),
    }
}

fn spots_remaining(max_people: Option<u32>, committed: u32) -> Option<u32> {
    max_people.map(|m| m.saturating_sub(committed))
}

fn single(min: u32, max: Option<u32>, step: u32, committed: u32) -> GroupState {
    let cap = max.unwrap_or(u32::MAX);

    if committed < min {
        return GroupState {
            complete_groups: 0,
            group_sizes: vec![],
            is_ready: false,
            waiting_count: committed,
            spots_to_next: Some(min - committed),
            spots_remaining: spots_remaining(max, committed),
        };
    }

    // Largest valid size n with min <= n <= cap and (n - min) % step == 0.
    let usable = committed.min(cap);
    let playable = min + ((usable - min) / step) * step;
    let waiting = committed - playable;

    // Next valid size we could grow to (bounded by cap).
    let next_size = playable + step;
    let spots_to_next = if next_size <= cap {
        Some(next_size - committed)
    } else {
        None
    };

    GroupState {
        complete_groups: 1,
        group_sizes: vec![playable],
        is_ready: true,
        waiting_count: waiting,
        spots_to_next,
        spots_remaining: spots_remaining(max, committed),
    }
}

fn tiling(min: u32, max: Option<u32>, group_size: u32, committed: u32) -> GroupState {
    let cap = max.unwrap_or(u32::MAX);

    if committed < min {
        return GroupState {
            complete_groups: 0,
            group_sizes: vec![],
            is_ready: false,
            waiting_count: committed,
            spots_to_next: Some(min - committed),
            spots_remaining: spots_remaining(max, committed),
        };
    }

    let usable = committed.min(cap);
    let groups = usable / group_size;
    let placed = groups * group_size;
    let waiting = committed - placed;

    // Commits needed to complete the next group, if a next group fits under cap.
    let next_total = placed + group_size;
    let spots_to_next = if next_total <= cap {
        Some(group_size - (usable - placed))
    } else {
        None
    };

    GroupState {
        complete_groups: groups,
        group_sizes: vec![group_size; groups as usize],
        is_ready: groups >= 1,
        waiting_count: waiting,
        spots_to_next,
        spots_remaining: spots_remaining(max, committed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_state(min: u32, max: Option<u32>, step: u32, c: u32) -> GroupState {
        compute_group_state(GroupingMode::Single, min, max, step, c)
    }
    fn tiling_state(min: u32, max: Option<u32>, step: u32, c: u32) -> GroupState {
        compute_group_state(GroupingMode::Tiling, min, max, step, c)
    }

    // ---- single mode -------------------------------------------------------

    #[test]
    fn single_below_min_not_ready() {
        // Blood on the Clocktower: 5..15, step 1.
        let s = single_state(5, Some(15), 1, 3);
        assert!(!s.is_ready);
        assert_eq!(s.complete_groups, 0);
        assert_eq!(s.waiting_count, 3);
        assert_eq!(s.spots_to_next, Some(2)); // need 2 more to reach min 5
        assert_eq!(s.spots_remaining, Some(12));
    }

    #[test]
    fn single_at_min_ready() {
        let s = single_state(5, Some(15), 1, 5);
        assert!(s.is_ready);
        assert_eq!(s.complete_groups, 1);
        assert_eq!(s.group_sizes, vec![5]);
        assert_eq!(s.waiting_count, 0);
        assert_eq!(s.spots_to_next, Some(1)); // step 1 -> next size 6
    }

    #[test]
    fn single_full_at_max_no_growth() {
        let s = single_state(5, Some(15), 1, 15);
        assert!(s.is_ready);
        assert_eq!(s.group_sizes, vec![15]);
        assert_eq!(s.spots_to_next, None); // cannot grow past max
        assert_eq!(s.spots_remaining, Some(0));
    }

    #[test]
    fn single_step_two_frisbee() {
        // Frisbee: min 4, max 20, even teams (step 2).
        let s = single_state(4, Some(20), 2, 5);
        assert!(s.is_ready);
        assert_eq!(s.group_sizes, vec![4]); // 5 rounds down to 4
        assert_eq!(s.waiting_count, 1);
        assert_eq!(s.spots_to_next, Some(1)); // need 1 more to reach 6
    }

    #[test]
    fn single_unlimited_max() {
        let s = single_state(2, None, 1, 10);
        assert!(s.is_ready);
        assert_eq!(s.group_sizes, vec![10]);
        assert_eq!(s.spots_remaining, None);
        assert_eq!(s.spots_to_next, Some(1));
    }

    // ---- tiling mode -------------------------------------------------------

    #[test]
    fn tiling_badminton_singles() {
        // Badminton: min 2, step 2, unlimited courts.
        let s = tiling_state(2, None, 2, 2);
        assert!(s.is_ready);
        assert_eq!(s.complete_groups, 1);
        assert_eq!(s.group_sizes, vec![2]);
        assert_eq!(s.waiting_count, 0);
        assert_eq!(s.spots_to_next, Some(2)); // a whole new court
    }

    #[test]
    fn tiling_multiple_courts_with_waiter() {
        let s = tiling_state(2, None, 2, 5);
        assert!(s.is_ready);
        assert_eq!(s.complete_groups, 2);
        assert_eq!(s.group_sizes, vec![2, 2]);
        assert_eq!(s.waiting_count, 1);
        assert_eq!(s.spots_to_next, Some(1)); // 1 more completes a 3rd court
    }

    #[test]
    fn tiling_below_min() {
        let s = tiling_state(4, None, 4, 3);
        assert!(!s.is_ready);
        assert_eq!(s.complete_groups, 0);
        assert_eq!(s.waiting_count, 3);
        assert_eq!(s.spots_to_next, Some(1));
    }

    #[test]
    fn tiling_capped_total() {
        // At most 4 people total (2 courts), step 2.
        let s = tiling_state(2, Some(4), 2, 4);
        assert_eq!(s.complete_groups, 2);
        assert_eq!(s.spots_to_next, None); // cap reached, no 3rd court
        assert_eq!(s.spots_remaining, Some(0));
    }

    #[test]
    fn tiling_group_multiple_four_doubles() {
        // Doubles badminton: groups of 4.
        let s = tiling_state(4, None, 4, 9);
        assert_eq!(s.complete_groups, 2);
        assert_eq!(s.group_sizes, vec![4, 4]);
        assert_eq!(s.waiting_count, 1);
        assert_eq!(s.spots_to_next, Some(3));
    }

    #[test]
    fn defensive_zero_multiple_treated_as_one() {
        let s = compute_group_state(GroupingMode::Single, 1, None, 0, 3);
        assert!(s.is_ready);
        assert_eq!(s.group_sizes, vec![3]);
    }

    // ---- grouping feasibility ----------------------------------------------

    #[test]
    fn feasible_single_uncapped() {
        assert!(grouping_is_feasible(GroupingMode::Single, 5, None, 1));
    }

    #[test]
    fn feasible_single_min_under_cap() {
        assert!(grouping_is_feasible(GroupingMode::Single, 5, Some(15), 1));
    }

    #[test]
    fn infeasible_single_min_over_cap() {
        // Can never reach the 5-person floor if capped at 3.
        assert!(!grouping_is_feasible(GroupingMode::Single, 5, Some(3), 1));
    }

    #[test]
    fn feasible_tiling_uncapped() {
        assert!(grouping_is_feasible(GroupingMode::Tiling, 4, None, 4));
    }

    #[test]
    fn infeasible_tiling_group_size_over_cap() {
        // Doubles (groups of 4) can never fit under a cap of 3.
        assert!(!grouping_is_feasible(GroupingMode::Tiling, 4, Some(3), 4));
    }

    #[test]
    fn feasible_tiling_group_size_equals_cap() {
        assert!(grouping_is_feasible(GroupingMode::Tiling, 4, Some(4), 4));
    }

    #[test]
    fn infeasible_tiling_min_over_cap_even_if_step_fits() {
        // min (6) exceeds the cap (5) even though step (2) alone would fit.
        assert!(!grouping_is_feasible(GroupingMode::Tiling, 6, Some(5), 2));
    }

    // ---- tiling guardrail: min/max must be exact multiples of the group size ----

    #[test]
    fn infeasible_tiling_min_not_multiple_of_step() {
        // 5 people can never split evenly into groups of 4.
        assert!(!grouping_is_feasible(GroupingMode::Tiling, 5, None, 4));
    }

    #[test]
    fn infeasible_tiling_max_not_multiple_of_step() {
        // A cap of 10 can never be fully used by groups of 4 (max leaves a remainder).
        assert!(!grouping_is_feasible(GroupingMode::Tiling, 4, Some(10), 4));
    }

    #[test]
    fn feasible_tiling_min_and_max_both_multiples() {
        assert!(grouping_is_feasible(GroupingMode::Tiling, 4, Some(12), 4));
    }
}
