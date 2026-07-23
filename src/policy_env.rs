//! Canonical server-side construction of policy evaluation globals.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use policy::eval::{EvalEnv, Value};
use serde::Deserialize;
#[cfg(target_arch = "wasm32")]
use worker::{D1Database, Error, Result};

use crate::logic::{compute_group_state, GroupingMode};
#[cfg(target_arch = "wasm32")]
use crate::models::{ActivityRow, RunRow};

#[derive(Debug, Clone, Deserialize)]
struct PolicyPersonRow {
    id: String,
    handle: String,
    state: Option<String>,
    arrival_at: Option<i64>,
    state_changed_at: Option<i64>,
}

/// Load a room snapshot and build all globals documented in `docs/language.md`.
///
/// `active_presence_since_ms` is an absolute cutoff. Presence at or after the
/// cutoff is included; callers own the liveness window so policy evaluation and
/// heartbeat/reaping can share one definition of "active".
#[cfg(target_arch = "wasm32")]
pub async fn build_env(
    db: &D1Database,
    activity_id: &str,
    run_id: &str,
    self_id: &str,
    iana_timezone: &str,
    now_ms: i64,
    active_presence_since_ms: i64,
) -> Result<EvalEnv> {
    let activity: ActivityRow = crate::db::get_activity(db, activity_id)
        .await?
        .ok_or_else(|| Error::RustError(format!("activity '{activity_id}' not found")))?;
    let run: RunRow = crate::db::get_run(db, run_id)
        .await?
        .ok_or_else(|| Error::RustError(format!("run '{run_id}' not found")))?;

    if run.activity_id != activity.id {
        return Err(Error::RustError(format!(
            "run '{run_id}' does not belong to activity '{activity_id}'"
        )));
    }

    // The actor is selected even when they neither participate nor have active
    // presence. Other people qualify through this run's participation or active
    // room presence. A participant who is also present remains a participant.
    let people = db
        .prepare(
            "SELECT pe.id AS id, pe.handle AS handle, part.state AS state, \
                    part.arrival_at AS arrival_at, \
                    COALESCE(part.state_changed_at, part.updated_at) AS state_changed_at \
             FROM people pe \
             LEFT JOIN participations part \
               ON part.person_id = pe.id AND part.run_id = ?1 \
             LEFT JOIN room_presence presence \
               ON presence.person_id = pe.id AND presence.activity_id = ?2 \
              AND presence.last_seen_at >= ?3 \
             WHERE pe.id = ?4 OR part.id IS NOT NULL OR presence.person_id IS NOT NULL \
             ORDER BY COALESCE(part.state_changed_at, presence.last_seen_at, pe.last_seen_at), pe.id",
        )
        .bind(&[
            crate::db::s(run_id),
            crate::db::s(activity_id),
            crate::db::i(active_presence_since_ms),
            crate::db::s(self_id),
        ])?
        .all()
        .await?
        .results::<PolicyPersonRow>()?;

    if !people.iter().any(|person| person.id == self_id) {
        return Err(Error::RustError(format!("person '{self_id}' not found")));
    }

    let config = ActivityPolicyConfig {
        title: &activity.title,
        code: &activity.code,
        min_people: activity.min_people,
        max_people: activity.max_people,
        group_multiple: activity.group_multiple,
        grouping_mode: &activity.grouping_mode,
        duration_seconds: activity.duration_seconds,
        max_commit_seconds: activity.max_commit_seconds,
    };
    Ok(build_values(
        &config,
        &people,
        self_id,
        iana_timezone,
        now_ms,
    ))
}

struct ActivityPolicyConfig<'a> {
    title: &'a str,
    code: &'a str,
    min_people: i64,
    max_people: Option<i64>,
    group_multiple: i64,
    grouping_mode: &'a str,
    duration_seconds: i64,
    max_commit_seconds: i64,
}

fn build_values(
    activity: &ActivityPolicyConfig<'_>,
    people: &[PolicyPersonRow],
    self_id: &str,
    iana_timezone: &str,
    now_ms: i64,
) -> EvalEnv {
    let mut interested = Vec::new();
    let mut committed = Vec::new();
    let mut arrived = Vec::new();
    let mut lurkers = Vec::new();
    let mut committed_arrivals = Vec::new();
    let mut committed_count = 0_u32;
    let mut self_value = None;

    for person in people {
        let value = person_value(person, now_ms);
        if person.id == self_id {
            self_value = Some(value.clone());
        }

        match person.state.as_deref() {
            Some("interested") => {
                interested.push(value);
            }
            Some("committed") => {
                committed_count = committed_count.saturating_add(1);
                if let Some(arrival_at) = person.arrival_at {
                    committed_arrivals.push(arrival_at);
                }
                // `committed` contains every commitment. `arrived` is a
                // subset, not a mutually exclusive replacement list.
                committed.push(value.clone());
                if person.arrival_at.is_some_and(|arrival| arrival <= now_ms) {
                    arrived.push(value);
                }
            }
            _ => lurkers.push(value),
        }
    }

    let self_value = self_value.unwrap_or_else(|| person_value_from("", None, None, None, now_ms));
    let mode = GroupingMode::parse(&activity.grouping_mode);
    let min_people = as_count(activity.min_people);
    let max_people = activity.max_people.map(as_count);
    let group_size = as_count(activity.group_multiple).max(1);
    let group = compute_group_state(mode, min_people, max_people, group_size, committed_count);
    let ready_in = ready_in_seconds(
        mode,
        min_people,
        max_people,
        group_size,
        &committed_arrivals,
        now_ms,
    );
    let local = local_clock(now_ms, iana_timezone);

    let mut vars = HashMap::new();
    vars.insert("self".into(), self_value);
    vars.insert("interested".into(), Value::List(interested));
    vars.insert("committed".into(), Value::List(committed));
    vars.insert("arrived".into(), Value::List(arrived));
    vars.insert("lurkers".into(), Value::List(lurkers));
    vars.insert("today".into(), variant("Day", local.day, vec![]));
    vars.insert(
        "now".into(),
        record(
            "Time",
            vec![
                ("hour", Value::Num(local.hour as f64)),
                ("minute", Value::Num(local.minute as f64)),
            ],
        ),
    );
    vars.insert("min_people".into(), Value::Num(min_people as f64));
    vars.insert(
        "max_people".into(),
        option(max_people.map(|count| Value::Num(count as f64))),
    );
    vars.insert("group_size".into(), Value::Num(group_size as f64));
    vars.insert(
        "grouping_mode".into(),
        variant(
            "Grouping",
            if mode == GroupingMode::Tiling {
                "Parallel"
            } else {
                "Single"
            },
            vec![],
        ),
    );
    vars.insert(
        "duration".into(),
        Value::Dur(activity.duration_seconds.max(0)),
    );
    vars.insert(
        "max_commit".into(),
        Value::Dur(activity.max_commit_seconds.max(0)),
    );
    vars.insert(
        "groups_ready".into(),
        Value::Num(group.complete_groups as f64),
    );
    vars.insert(
        "waiting_count".into(),
        Value::Num(group.waiting_count as f64),
    );
    vars.insert(
        "spots_to_next".into(),
        Value::Num(group.spots_to_next.unwrap_or(0) as f64),
    );
    vars.insert("is_ready".into(), Value::Bool(group.is_ready));
    vars.insert("ready_in".into(), option(ready_in.map(Value::Dur)));
    vars.insert("title".into(), Value::Str(activity.title.to_string()));
    vars.insert("code".into(), Value::Str(activity.code.to_string()));

    EvalEnv { vars }
}

/// Predict when the earliest playable cohort will all have arrived.
///
/// Unknown arrival times are excluded. Therefore a result exists only when
/// enough currently committed people have known arrivals. The Nth earliest
/// arrival, rather than the latest arrival among every commitment, determines
/// the first cohort's ready time.
fn ready_in_seconds(
    mode: GroupingMode,
    min_people: u32,
    max_people: Option<u32>,
    group_size: u32,
    committed_arrivals: &[i64],
    now_ms: i64,
) -> Option<i64> {
    let minimum = min_people.max(1);
    let needed = match mode {
        GroupingMode::Single => minimum,
        GroupingMode::Tiling => minimum.max(group_size.max(1)),
    };
    if max_people.is_some_and(|cap| cap < needed) {
        return None;
    }
    let needed = usize::try_from(needed).ok()?;
    if committed_arrivals.len() < needed {
        return None;
    }

    let mut arrivals = committed_arrivals.to_vec();
    arrivals.sort_unstable();
    Some(seconds_until(arrivals[needed - 1], now_ms))
}

fn seconds_until(target_ms: i64, now_ms: i64) -> i64 {
    let delta = i128::from(target_ms) - i128::from(now_ms);
    if delta <= 0 {
        0
    } else {
        ((delta + 999) / 1_000).min(i128::from(i64::MAX)) as i64
    }
}

fn elapsed_seconds(since_ms: Option<i64>, now_ms: i64) -> i64 {
    since_ms
        .map(|since| (i128::from(now_ms) - i128::from(since)).max(0) / 1_000)
        .unwrap_or(0)
        .min(i128::from(i64::MAX)) as i64
}

fn person_value(person: &PolicyPersonRow, now_ms: i64) -> Value {
    person_value_from(
        &person.handle,
        person.state.as_deref(),
        person.arrival_at,
        person.state_changed_at,
        now_ms,
    )
}

fn person_value_from(
    name: &str,
    state: Option<&str>,
    arrival_at: Option<i64>,
    state_changed_at: Option<i64>,
    now_ms: i64,
) -> Value {
    let state = match state {
        Some("interested") => variant("State", "Interested", vec![]),
        Some("committed") if arrival_at.is_some_and(|arrival| arrival <= now_ms) => {
            variant("State", "Arrived", vec![Value::Dur(0)])
        }
        Some("committed") => variant(
            "State",
            "Committed",
            // The current State type cannot encode an unknown ETA. Keep its
            // required duration neutral; raw arrival timestamps still ensure
            // unknown values do not contribute to `ready_in`.
            vec![Value::Dur(
                arrival_at.map_or(0, |arrival| seconds_until(arrival, now_ms)),
            )],
        ),
        _ => variant("State", "Lurker", vec![]),
    };
    record(
        "Person",
        vec![
            ("name", Value::Str(name.to_string())),
            ("state", state),
            (
                "engaged_for",
                Value::Dur(elapsed_seconds(state_changed_at, now_ms)),
            ),
        ],
    )
}

fn option(value: Option<Value>) -> Value {
    match value {
        Some(value) => variant("Option", "Some", vec![value]),
        None => variant("Option", "None", vec![]),
    }
}

fn variant(type_name: &str, name: &str, values: Vec<Value>) -> Value {
    Value::Variant {
        type_name: type_name.to_string(),
        name: name.to_string(),
        values,
    }
}

fn record(type_name: &str, fields: Vec<(&str, Value)>) -> Value {
    Value::Record {
        type_name: type_name.to_string(),
        fields: fields
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect::<BTreeMap<_, _>>(),
    }
}

fn as_count(value: i64) -> u32 {
    value.clamp(0, i64::from(u32::MAX)) as u32
}

struct LocalClock {
    hour: u32,
    minute: u32,
    day: &'static str,
}

fn local_clock(epoch_ms: i64, iana_timezone: &str) -> LocalClock {
    let timezone = iana_timezone.parse::<Tz>().unwrap_or(chrono_tz::UTC);
    let utc = DateTime::<Utc>::from_timestamp_millis(epoch_ms).unwrap_or(DateTime::UNIX_EPOCH);
    let local = utc.with_timezone(&timezone);
    let day = match local.weekday() {
        Weekday::Mon => "Mon",
        Weekday::Tue => "Tue",
        Weekday::Wed => "Wed",
        Weekday::Thu => "Thu",
        Weekday::Fri => "Fri",
        Weekday::Sat => "Sat",
        Weekday::Sun => "Sun",
    };
    LocalClock {
        hour: local.hour(),
        minute: local.minute(),
        day,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_in_uses_nth_known_arrival_for_single_group() {
        let now = 1_000_000;
        let arrivals = [now + 50_000, now + 10_001, now + 30_000, now + 90_000];
        assert_eq!(
            ready_in_seconds(GroupingMode::Single, 3, Some(8), 1, &arrivals, now),
            Some(50)
        );
    }

    #[test]
    fn ready_in_requires_enough_known_arrivals() {
        let now = 1_000_000;
        assert_eq!(
            ready_in_seconds(GroupingMode::Single, 3, None, 1, &[now, now + 1_000], now),
            None
        );
    }

    #[test]
    fn ready_in_honors_tiling_floor_and_elapsed_arrivals() {
        let now = 1_000_000;
        let arrivals = [now - 5_000, now - 1, now + 2_001, now + 20_000];
        assert_eq!(
            ready_in_seconds(GroupingMode::Tiling, 2, None, 4, &arrivals, now),
            Some(20)
        );
        assert_eq!(
            ready_in_seconds(GroupingMode::Tiling, 2, Some(3), 4, &arrivals, now),
            None
        );
    }

    #[test]
    fn person_values_use_real_name_eta_and_elapsed_engagement() {
        let now = 1_000_000;
        let committed = person_value_from(
            "Ada",
            Some("committed"),
            Some(now + 1_001),
            Some(now - 70_000),
            now,
        );
        let arrived = person_value_from(
            "Grace",
            Some("committed"),
            Some(now - 10_000),
            Some(now - 70_000),
            now,
        );

        assert_person(&committed, "Ada", "Committed", 2, 70);
        assert_person(&arrived, "Grace", "Arrived", 0, 70);
    }

    #[test]
    fn value_construction_populates_every_documented_global() {
        let now = 1_000_000;
        let config = ActivityPolicyConfig {
            title: "Evening Match",
            code: "PLAY",
            min_people: 2,
            max_people: Some(8),
            group_multiple: 1,
            grouping_mode: "single",
            duration_seconds: 1_800,
            max_commit_seconds: 900,
        };
        let people = vec![
            person("self", "Lin", Some("committed"), Some(now + 1_000), now),
            person("arrived", "Ada", Some("committed"), Some(now - 1), now),
            person("interested", "Grace", Some("interested"), None, now),
            person("lurker", "Edsger", None, None, now),
        ];
        let env = build_values(&config, &people, "self", "UTC", now);
        let mut names = env.vars.keys().map(String::as_str).collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "arrived",
                "code",
                "committed",
                "duration",
                "group_size",
                "grouping_mode",
                "groups_ready",
                "interested",
                "is_ready",
                "lurkers",
                "max_commit",
                "max_people",
                "min_people",
                "now",
                "ready_in",
                "self",
                "spots_to_next",
                "title",
                "today",
                "waiting_count",
            ]
        );
        assert!(matches!(env.vars.get("is_ready"), Some(Value::Bool(true))));
        assert!(matches!(
            env.vars.get("ready_in"),
            Some(Value::Variant { name, values, .. })
                if name == "Some" && matches!(values.as_slice(), [Value::Dur(1)])
        ));
        assert_list_person(&env, "committed", "Ada", "Arrived");
        assert_list_person(&env, "arrived", "Ada", "Arrived");
        assert_list_person(&env, "interested", "Grace", "Interested");
        assert_list_person(&env, "lurkers", "Edsger", "Lurker");
    }

    #[test]
    fn local_clock_uses_iana_timezone_and_falls_back_to_utc() {
        // 2024-01-01 00:30 UTC: still Sunday afternoon in Los Angeles.
        let epoch_ms = 1_704_069_000_000;
        let local = local_clock(epoch_ms, "America/Los_Angeles");
        assert_eq!((local.hour, local.minute, local.day), (16, 30, "Sun"));

        let utc = local_clock(epoch_ms, "not/a-zone");
        assert_eq!((utc.hour, utc.minute, utc.day), (0, 30, "Mon"));
    }

    fn assert_person(
        value: &Value,
        expected_name: &str,
        expected_state: &str,
        secs: i64,
        engaged_secs: i64,
    ) {
        let Value::Record { type_name, fields } = value else {
            panic!("expected Person record")
        };
        assert_eq!(type_name, "Person");
        assert!(matches!(fields.get("name"), Some(Value::Str(name)) if name == expected_name));
        let Some(Value::Variant {
            type_name,
            name,
            values,
        }) = fields.get("state")
        else {
            panic!("expected State variant")
        };
        assert_eq!(type_name, "State");
        assert_eq!(name, expected_state);
        assert!(matches!(values.as_slice(), [Value::Dur(value)] if *value == secs));
        assert!(
            matches!(fields.get("engaged_for"), Some(Value::Dur(value)) if *value == engaged_secs)
        );
    }

    fn person(
        id: &str,
        handle: &str,
        state: Option<&str>,
        arrival_at: Option<i64>,
        state_changed_at: i64,
    ) -> PolicyPersonRow {
        PolicyPersonRow {
            id: id.to_string(),
            handle: handle.to_string(),
            state: state.map(str::to_string),
            arrival_at,
            state_changed_at: Some(state_changed_at),
        }
    }

    fn assert_list_person(env: &EvalEnv, list_name: &str, expected_name: &str, state: &str) {
        let Some(Value::List(values)) = env.vars.get(list_name) else {
            panic!("expected {list_name} list")
        };
        let Some(Value::Record { fields, .. }) = values.iter().find(|value| {
            matches!(value, Value::Record { fields, .. }
                if matches!(fields.get("name"), Some(Value::Str(name)) if name == expected_name))
        }) else {
            panic!("expected person in {list_name}")
        };
        assert!(matches!(fields.get("name"), Some(Value::Str(name)) if name == expected_name));
        assert!(matches!(
            fields.get("state"),
            Some(Value::Variant { name, .. }) if name == state
        ));
    }
}
