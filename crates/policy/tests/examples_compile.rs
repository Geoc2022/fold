use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;

use policy::eval::{Effect, EvalEnv, Value};
use serde::Deserialize;

#[derive(Debug)]
struct PolicyExample {
    heading: String,
    line: usize,
    source: String,
    scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
struct Scenario {
    name: String,
    #[serde(default)]
    env: ScenarioEnv,
    #[serde(default)]
    events: Vec<ExpectedEvent>,
}

#[derive(Debug, Default, Deserialize)]
struct ScenarioEnv {
    committed_count: Option<usize>,
    interested_count: Option<usize>,
    arrived_count: Option<usize>,
    lurkers_count: Option<usize>,
    committed_eta_secs: Option<i64>,
    committed_waited_secs: Option<i64>,
    arrived_waited_secs: Option<i64>,
    min_people: Option<f64>,
    max_people: Option<f64>,
    group_size: Option<f64>,
    groups_ready: Option<f64>,
    waiting_count: Option<f64>,
    spots_to_next: Option<f64>,
    is_ready: Option<bool>,
    ready_in_secs: Option<i64>,
    today: Option<String>,
    now_hour: Option<i64>,
    now_minute: Option<i64>,
    title: Option<String>,
    code: Option<String>,
    self_state: Option<String>,
    self_eta_secs: Option<i64>,
    self_waited_secs: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ExpectedEvent {
    #[serde(default)]
    after_secs: i64,
    #[serde(default)]
    notify: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    eta_delta_secs: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ScenarioSpec {
    One(Scenario),
    Many(Vec<Scenario>),
    Wrapped { scenarios: Vec<Scenario> },
}

#[derive(Debug, Clone, PartialEq)]
enum TimelineEvent {
    Notify {
        after_secs: i64,
        message: String,
    },
    State {
        after_secs: i64,
        state: String,
        eta_delta_secs: Option<i64>,
    },
}

fn parse_examples(markdown: &str) -> Vec<PolicyExample> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut examples = Vec::new();
    let mut i = 0usize;
    let mut last_heading = "(untitled)".to_string();

    while i < lines.len() {
        let trimmed = lines[i].trim();
        if let Some(h) = parse_heading(trimmed) {
            last_heading = h.to_string();
            i += 1;
            continue;
        }

        if trimmed == "```policy" {
            let start_line = i + 1;
            i += 1;
            let mut source = String::new();
            while i < lines.len() && lines[i].trim() != "```" {
                source.push_str(lines[i]);
                source.push('\n');
                i += 1;
            }
            assert!(
                i < lines.len(),
                "unterminated policy block under heading '{}' at line {}",
                last_heading,
                start_line
            );

            i += 1;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }

            assert!(
                i < lines.len() && lines[i].trim() == "<!-- policy-test",
                "missing policy-test metadata after heading '{}' at line {}",
                last_heading,
                start_line
            );

            i += 1;
            let mut json = String::new();
            while i < lines.len() && lines[i].trim() != "-->" {
                json.push_str(lines[i]);
                json.push('\n');
                i += 1;
            }
            assert!(
                i < lines.len(),
                "unterminated policy-test metadata under heading '{}' at line {}",
                last_heading,
                start_line
            );

            let scenarios = parse_scenarios(&json, &last_heading, start_line);
            assert!(
                !scenarios.is_empty(),
                "no scenarios found in metadata under heading '{}' at line {}",
                last_heading,
                start_line
            );

            examples.push(PolicyExample {
                heading: last_heading.clone(),
                line: start_line,
                source: source.trim_end().to_string(),
                scenarios,
            });
        }

        i += 1;
    }

    examples
}

fn parse_heading(trimmed: &str) -> Option<&str> {
    if !trimmed.starts_with('#') {
        return None;
    }
    trimmed.split_once(' ').map(|(_, rest)| rest.trim())
}

fn parse_scenarios(json: &str, heading: &str, line: usize) -> Vec<Scenario> {
    let spec: ScenarioSpec = serde_json::from_str(json).unwrap_or_else(|e| {
        panic!(
            "invalid policy-test metadata for heading '{}' at line {}: {}\n{}",
            heading, line, e, json
        )
    });
    let scenarios = match spec {
        ScenarioSpec::One(s) => vec![s],
        ScenarioSpec::Many(v) => v,
        ScenarioSpec::Wrapped { scenarios } => scenarios,
    };

    let mut names: HashMap<&str, usize> = HashMap::new();
    for s in &scenarios {
        assert!(
            !s.name.trim().is_empty(),
            "scenario name cannot be empty for heading '{}' at line {}",
            heading,
            line
        );
        let count = names.entry(s.name.as_str()).or_insert(0);
        *count += 1;
        assert!(
            *count == 1,
            "duplicate scenario name '{}' under heading '{}' at line {}",
            s.name,
            heading,
            line
        );
        for event in &s.events {
            let has_notify = event.notify.is_some();
            let has_state = event.state.is_some();
            assert!(
                has_notify ^ has_state,
                "scenario '{}' under heading '{}' at line {} must define exactly one of notify/state per event",
                s.name,
                heading,
                line
            );
            if has_notify {
                assert!(
                    event.eta_delta_secs.is_none(),
                    "scenario '{}' under heading '{}' at line {} cannot set eta_delta_secs on notify event",
                    s.name,
                    heading,
                    line
                );
            }
        }
    }

    scenarios
}

fn person_value(state: &str, eta_secs: i64, waited_secs: i64) -> Value {
    let variant = match state {
        "committed" => Value::Variant {
            type_name: "State".to_string(),
            name: "Committed".to_string(),
            values: vec![Value::Dur(eta_secs.max(0))],
        },
        "arrived" => Value::Variant {
            type_name: "State".to_string(),
            name: "Arrived".to_string(),
            values: vec![Value::Dur(0)],
        },
        "interested" => Value::Variant {
            type_name: "State".to_string(),
            name: "Interested".to_string(),
            values: vec![],
        },
        "lurker" => Value::Variant {
            type_name: "State".to_string(),
            name: "Lurker".to_string(),
            values: vec![],
        },
        other => panic!(
            "unsupported state '{}'; expected committed|arrived|interested|lurker",
            other
        ),
    };

    Value::Record {
        type_name: "Person".to_string(),
        fields: BTreeMap::from([
            ("name".to_string(), Value::Str(String::new())),
            ("state".to_string(), variant),
            ("engaged_for".to_string(), Value::Dur(waited_secs.max(0))),
        ]),
    }
}

fn option_num(v: Option<f64>) -> Value {
    match v {
        Some(n) => Value::Variant {
            type_name: "Option".to_string(),
            name: "Some".to_string(),
            values: vec![Value::Num(n)],
        },
        None => Value::Variant {
            type_name: "Option".to_string(),
            name: "None".to_string(),
            values: vec![],
        },
    }
}

fn option_dur(v: Option<i64>) -> Value {
    match v {
        Some(d) => Value::Variant {
            type_name: "Option".to_string(),
            name: "Some".to_string(),
            values: vec![Value::Dur(d.max(0))],
        },
        None => Value::Variant {
            type_name: "Option".to_string(),
            name: "None".to_string(),
            values: vec![],
        },
    }
}

fn day_variant(day: Option<&str>) -> Value {
    let d = day.unwrap_or("Tue");
    let valid = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    assert!(valid.contains(&d), "invalid day '{}'", d);
    Value::Variant {
        type_name: "Day".to_string(),
        name: d.to_string(),
        values: vec![],
    }
}

fn env_from_scenario(env: &ScenarioEnv) -> EvalEnv {
    let committed_count = env.committed_count.unwrap_or(0);
    let interested_count = env.interested_count.unwrap_or(0);
    let arrived_count = env.arrived_count.unwrap_or(0);
    let lurkers_count = env.lurkers_count.unwrap_or(0);
    let committed_eta_secs = env.committed_eta_secs.unwrap_or(0);
    let committed_waited_secs = env.committed_waited_secs.unwrap_or(0);
    let arrived_waited_secs = env.arrived_waited_secs.unwrap_or(0);

    let committed =
        vec![person_value("committed", committed_eta_secs, committed_waited_secs); committed_count];
    let interested = vec![person_value("interested", 0, 0); interested_count];
    let arrived = vec![person_value("arrived", 0, arrived_waited_secs); arrived_count];
    let lurkers = vec![person_value("lurker", 0, 0); lurkers_count];

    let self_state = env.self_state.as_deref().unwrap_or("lurker");
    let self_eta_secs = env.self_eta_secs.unwrap_or(0);
    let self_waited_secs = env.self_waited_secs.unwrap_or(0);
    let self_person = person_value(self_state, self_eta_secs, self_waited_secs);

    let vars: HashMap<String, Value> = BTreeMap::from([
        ("self".to_string(), self_person),
        ("interested".to_string(), Value::List(interested)),
        ("committed".to_string(), Value::List(committed)),
        ("arrived".to_string(), Value::List(arrived)),
        ("lurkers".to_string(), Value::List(lurkers)),
        ("today".to_string(), day_variant(env.today.as_deref())),
        (
            "now".to_string(),
            Value::Record {
                type_name: "Time".to_string(),
                fields: BTreeMap::from([
                    (
                        "hour".to_string(),
                        Value::Num(env.now_hour.unwrap_or(16) as f64),
                    ),
                    (
                        "minute".to_string(),
                        Value::Num(env.now_minute.unwrap_or(30) as f64),
                    ),
                ]),
            },
        ),
        (
            "min_people".to_string(),
            Value::Num(env.min_people.unwrap_or(3.0)),
        ),
        (
            "max_people".to_string(),
            option_num(Some(env.max_people.unwrap_or(8.0))),
        ),
        (
            "group_size".to_string(),
            Value::Num(env.group_size.unwrap_or(4.0)),
        ),
        (
            "grouping_mode".to_string(),
            Value::Variant {
                type_name: "Grouping".to_string(),
                name: "Single".to_string(),
                values: vec![],
            },
        ),
        ("duration".to_string(), Value::Dur(60 * 60)),
        ("max_commit".to_string(), Value::Dur(60 * 60)),
        (
            "groups_ready".to_string(),
            Value::Num(env.groups_ready.unwrap_or(0.0)),
        ),
        (
            "waiting_count".to_string(),
            Value::Num(env.waiting_count.unwrap_or(0.0)),
        ),
        (
            "spots_to_next".to_string(),
            Value::Num(env.spots_to_next.unwrap_or(0.0)),
        ),
        (
            "is_ready".to_string(),
            Value::Bool(env.is_ready.unwrap_or(false)),
        ),
        ("ready_in".to_string(), option_dur(env.ready_in_secs)),
        (
            "title".to_string(),
            Value::Str(
                env.title
                    .as_deref()
                    .unwrap_or("Sample Activity")
                    .to_string(),
            ),
        ),
        (
            "code".to_string(),
            Value::Str(env.code.as_deref().unwrap_or("ABCD").to_string()),
        ),
    ])
    .into_iter()
    .collect();

    EvalEnv { vars }
}

fn collect_timeline(effect: &Effect, offset_secs: i64, out: &mut Vec<TimelineEvent>) -> i64 {
    match effect {
        Effect::Notify { message } => {
            out.push(TimelineEvent::Notify {
                after_secs: offset_secs,
                message: message.clone(),
            });
            offset_secs
        }
        Effect::SetState {
            state,
            eta_delta_secs,
        } => {
            out.push(TimelineEvent::State {
                after_secs: offset_secs,
                state: state.clone(),
                eta_delta_secs: *eta_delta_secs,
            });
            offset_secs
        }
        Effect::Sleep { secs } => offset_secs + (*secs).max(0),
        Effect::Seq { steps } => {
            let mut current = offset_secs;
            for step in steps {
                current = collect_timeline(step, current, out);
            }
            current
        }
        Effect::Noop => offset_secs,
    }
}

fn expected_timeline(events: &[ExpectedEvent]) -> Vec<TimelineEvent> {
    events
        .iter()
        .map(|event| {
            if let Some(message) = &event.notify {
                TimelineEvent::Notify {
                    after_secs: event.after_secs,
                    message: message.clone(),
                }
            } else {
                TimelineEvent::State {
                    after_secs: event.after_secs,
                    state: event
                        .state
                        .as_ref()
                        .expect("state event must include state")
                        .clone(),
                    eta_delta_secs: event.eta_delta_secs,
                }
            }
        })
        .collect()
}

fn assert_examples_file(docs_path: &PathBuf) {
    let markdown =
        fs::read_to_string(docs_path).unwrap_or_else(|_| panic!("read {}", docs_path.display()));
    let examples = parse_examples(&markdown);
    assert!(
        !examples.is_empty(),
        "no policy examples found in {}",
        docs_path.display()
    );

    for example in &examples {
        let compiled = policy::compile_policy_with_diagnostics(&example.source);
        assert!(
            compiled.diagnostics.is_empty(),
            "example '{}' in {} at line {} failed to compile:\n{}\n\nfirst diagnostic: {}",
            example.heading,
            docs_path.display(),
            example.line,
            example.source,
            compiled
                .diagnostics
                .first()
                .map(|d| d.message.as_str())
                .unwrap_or("<none>")
        );
        let policy = compiled.policy.expect("compiled policy missing");

        for scenario in &example.scenarios {
            let env = env_from_scenario(&scenario.env);
            let result = policy::evaluate_policy_safe(&policy, &env);
            assert!(
                result.error.is_none(),
                "scenario '{}' under '{}' in {} at line {} returned runtime error: {}",
                scenario.name,
                example.heading,
                docs_path.display(),
                example.line,
                result.error.as_deref().unwrap_or("<none>")
            );

            let mut actual = Vec::new();
            if let Some(effect) = result.fired.as_ref() {
                collect_timeline(effect, 0, &mut actual);
            }
            let expected = expected_timeline(&scenario.events);

            assert_eq!(
                actual,
                expected,
                "scenario '{}' under '{}' in {} at line {} produced unexpected timeline",
                scenario.name,
                example.heading,
                docs_path.display(),
                example.line
            );
        }
    }
}

#[test]
fn policy_examples_in_docs_compile_and_match_runtime_scenarios() {
    let docs_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs");

    for file in ["policy-examples.md", "policy-examples-stress.md"] {
        let docs_path = docs_root.join(file);
        assert_examples_file(&docs_path);
    }
}
