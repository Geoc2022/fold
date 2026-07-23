//! # Policy language (v2)
//!
//! A small, strongly-typed, purely-functional language for authoring room /
//! notification policies, compiled to WASM. It reads like "simplified OCaml
//! with adjusted syntax":
//!
//! - **Commas gather data** (`[a, b, c]`, `(a, b)`, `{ x = 1 }`), **spaces
//!   apply functions** (`map f xs`). Newlines separate statements; no
//!   semicolons.
//! - Currying + juxtaposition, `match`/variants/records/`Option`, and
//!   `(* nestable comments *)` come from **OCaml/ML**, with Hindley–Milner
//!   inference.
//! - Type classes are **traits** (`trait`/`impl`), the enum AST, and
//!   `println!`-style `notify` come from **Rust**.
//! - Newline layout, comma literals, and `and`/`or`/`not`/`xor` come from
//!   **Python**.
//!
//! A policy is `condition => action`; evaluating it yields a structured
//! [`eval::Effect`] program the host runs against the simulation.

pub mod ast;
pub mod diag;
pub mod docs;
pub mod eval;
pub mod lex;
pub mod parse;
pub mod prelude;
pub mod typeck;
pub mod types;

use ast::TypedProgram;
use diag::Diagnostic;
use eval::{eval_expr, eval_program, Effect, EvalEnv};
use serde::{Deserialize, Serialize};
use typeck::TypeContext;

thread_local! {
    static CONTEXT: TypeContext = TypeContext::default();
}

fn with_context<R>(f: impl FnOnce(&TypeContext) -> R) -> R {
    CONTEXT.with(f)
}

pub fn compile_policy(source: &str) -> Result<TypedProgram, Vec<Diagnostic>> {
    let program = parse::parse_program(source)?;
    with_context(|ctx| typeck::typecheck_program(program, ctx))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub policy: Option<TypedProgram>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn compile_policy_with_diagnostics(source: &str) -> CompileResult {
    match compile_policy(source) {
        Ok(policy) => CompileResult {
            policy: Some(policy),
            diagnostics: Vec::new(),
        },
        Err(diagnostics) => CompileResult {
            policy: None,
            diagnostics,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluateResult {
    /// The effect program to run when the condition holds; `None` otherwise.
    pub fired: Option<Effect>,
    pub error: Option<String>,
}

pub fn evaluate_policy_safe(policy: &TypedProgram, env: &EvalEnv) -> EvaluateResult {
    match eval_program(policy, env) {
        Ok(fired) => EvaluateResult { fired, error: None },
        Err(e) => EvaluateResult {
            fired: None,
            error: Some(e.0),
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalExprResult {
    pub output: Option<String>,
    pub ty: Option<String>,
    pub error: Option<String>,
}

/// Parse, type-check, and evaluate a standalone expression (terminal/REPL).
pub fn evaluate_expression(source: &str, env: &EvalEnv) -> EvalExprResult {
    let expr = match parse::parse_expr_str(source) {
        Ok(e) => e,
        Err(diags) => {
            return EvalExprResult {
                output: None,
                ty: None,
                error: Some(first_message(&diags, "parse error")),
            }
        }
    };
    let ty = match with_context(|ctx| typeck::typecheck_expr(&expr, ctx)) {
        Ok(t) => t,
        Err(diags) => {
            return EvalExprResult {
                output: None,
                ty: None,
                error: Some(first_message(&diags, "type error")),
            }
        }
    };
    match eval_expr(&expr, env) {
        Ok(value) => EvalExprResult {
            output: Some(eval::format_value(&value)),
            ty: Some(typeck::ty_to_string(&ty)),
            error: None,
        },
        Err(e) => EvalExprResult {
            output: None,
            ty: None,
            error: Some(e.0),
        },
    }
}

fn first_message(diags: &[Diagnostic], fallback: &str) -> String {
    diags
        .first()
        .map(|d| d.message.clone())
        .unwrap_or_else(|| fallback.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightToken {
    pub kind: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightResult {
    pub tokens: Vec<HighlightToken>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn highlight_policy(source: &str) -> HighlightResult {
    match lex::lex(source) {
        Ok(tokens) => HighlightResult {
            tokens: tokens
                .into_iter()
                .filter_map(|t| {
                    token_kind_name(&t.kind).map(|kind| HighlightToken {
                        kind: kind.to_string(),
                        start: t.span.start,
                        end: t.span.end,
                    })
                })
                .collect(),
            diagnostics: Vec::new(),
        },
        Err(diagnostics) => HighlightResult {
            tokens: Vec::new(),
            diagnostics,
        },
    }
}

/// The generated Markdown language reference.
pub fn language_docs() -> String {
    docs::language_docs()
}

fn token_kind_name(kind: &lex::TokenKind) -> Option<&'static str> {
    use lex::TokenKind as T;
    let name = match kind {
        T::Ident(_) | T::Underscore => "ident",
        T::UIdent(_) => "type",
        T::Str(_) => "string",
        T::Number(_) => "number",
        T::DurationSecs(_) => "duration",
        T::True | T::False => "bool",
        T::Fun
        | T::Match
        | T::With
        | T::If
        | T::Then
        | T::Else
        | T::Before
        | T::By
        | T::Type
        | T::Trait
        | T::Impl => "keyword",
        T::And | T::Or | T::Not | T::Xor => "keyword",
        T::Hash
        | T::Plus
        | T::Minus
        | T::Star
        | T::Slash
        | T::Percent
        | T::Lt
        | T::Lte
        | T::Gt
        | T::Gte
        | T::EqEq
        | T::Neq
        | T::Eq
        | T::FatArrow
        | T::Arrow
        | T::ColonColon
        | T::Pipe => "operator",
        T::Dot
        | T::Comma
        | T::Colon
        | T::LParen
        | T::RParen
        | T::LBracket
        | T::RBracket
        | T::LBrace
        | T::RBrace => "punct",
        T::DocComment(_) => "comment",
        T::Newline | T::Indent | T::Dedent | T::Eof => return None,
    };
    Some(name)
}

#[cfg(feature = "wasm")]
pub mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::{
        compile_policy_with_diagnostics, evaluate_expression, evaluate_policy_safe,
        highlight_policy, language_docs, EvalEnv, TypedProgram,
    };

    #[wasm_bindgen]
    pub fn eval_expr_json(source: &str, env_json: &str) -> String {
        let env = match serde_json::from_str::<EvalEnv>(env_json) {
            Ok(v) => v,
            Err(e) => {
                return format!(
                    "{{\"output\":null,\"ty\":null,\"error\":\"invalid env json: {e}\"}}"
                )
            }
        };
        serde_json::to_string(&evaluate_expression(source, &env)).unwrap_or_else(|_| {
            "{\"output\":null,\"ty\":null,\"error\":\"serialization failed\"}".to_string()
        })
    }

    #[wasm_bindgen]
    pub fn compile_policy_json(source: &str) -> String {
        serde_json::to_string(&compile_policy_with_diagnostics(source)).unwrap_or_else(|_| {
            "{\"policy\":null,\"diagnostics\":[{\"span\":{\"start\":0,\"end\":0},\"message\":\"serialization failed\"}]}".to_string()
        })
    }

    #[wasm_bindgen]
    pub fn evaluate_policy_json(policy_json: &str, env_json: &str) -> String {
        let policy = match serde_json::from_str::<TypedProgram>(policy_json) {
            Ok(p) => p,
            Err(e) => return format!("{{\"fired\":null,\"error\":\"invalid policy json: {e}\"}}"),
        };
        let env = match serde_json::from_str::<EvalEnv>(env_json) {
            Ok(v) => v,
            Err(e) => return format!("{{\"fired\":null,\"error\":\"invalid env json: {e}\"}}"),
        };
        serde_json::to_string(&evaluate_policy_safe(&policy, &env))
            .unwrap_or_else(|_| "{\"fired\":null,\"error\":\"serialization failed\"}".to_string())
    }

    #[wasm_bindgen]
    pub fn highlight_policy_json(source: &str) -> String {
        serde_json::to_string(&highlight_policy(source))
            .unwrap_or_else(|_| "{\"tokens\":[],\"diagnostics\":[]}".to_string())
    }

    #[wasm_bindgen]
    pub fn policy_docs() -> String {
        language_docs()
    }
}

#[cfg(test)]
mod smoke {
    use crate::parse::{parse_expr_str, parse_program};
    use crate::typeck::{ty_to_string, typecheck_expr, typecheck_program, TypeContext};

    fn ty_of(src: &str) -> String {
        let e = parse_expr_str(src).expect("parse");
        let t = typecheck_expr(&e, &TypeContext::default()).expect("typecheck");
        ty_to_string(&t)
    }

    #[test]
    fn prelude_builds() {
        let _ = TypeContext::default();
    }

    #[test]
    fn infers_basic_types() {
        assert_eq!(ty_of("1 + 2"), "Num");
        assert_eq!(ty_of("#committed"), "Num");
        assert_eq!(ty_of("map (fun x -> x + 1) [1, 2, 3]"), "List<Num>");
        assert_eq!(ty_of("filter (fun x -> x > 2) [1, 2, 3]"), "List<Num>");
        assert_eq!(ty_of("Some(3)"), "Option<Num>");
        assert_eq!(ty_of("is_weekend today"), "Bool");
        assert_eq!(ty_of("self.name"), "Str");
        assert_eq!(ty_of("eta self"), "Option<Dur>");
        assert_eq!(ty_of("unwrap_or 0s (eta self)"), "Dur");
        assert_eq!(ty_of("now.hour"), "Num");
    }

    #[test]
    fn programs_typecheck() {
        let ctx = TypeContext::default();
        let ok = |src: &str| {
            let p = parse_program(src).expect("parse");
            typecheck_program(p, &ctx).expect(src);
        };
        ok("#committed > min_people => notify \"ready!\"");
        ok("is_weekend today => lurk");
        ok("count = #interested\ncount > 3 => notify \"we have {count} interested\"");
        ok("type Mood = Happy | Sad\nm = Happy\nmatch m with | Happy -> true | Sad -> false => commit");
        ok("any is_committed interested => { notify \"someone committed\", commit }");
        // A policy can be a bare action (no `=>` rule).
        ok("commit");
        ok("commit +3m");
        ok("commit -3m");
        // A `match` must be exhaustive; a `_` arm covers the rest.
        ok("match #committed with | 2 -> commit | 3 -> lurk | _ -> {}");
        // Notify a duration before the group is ready, via `ready_in`.
        ok("match ready_in with | Some(t) -> delay (notify \"3 min!\") (t - 3min) | None -> {}");
        ok("notify \"starting in 3 min!\" before ready_in by 3min");
    }

    #[test]
    fn rejects_nonexhaustive_match() {
        let ctx = TypeContext::default();
        // Missing a `_` arm: exhaustiveness is enforced even for Action matches.
        let p = parse_program("match #committed with | 2 -> commit | 3 -> lurk").expect("parse");
        assert!(typecheck_program(p, &ctx).is_err());
    }

    #[test]
    fn evaluates_programs() {
        use crate::eval::{eval_expr, eval_program, Effect, EvalEnv, Value};
        use std::collections::BTreeMap;

        fn person(name: &str, state: &str, secs: i64) -> Value {
            let mut fields = BTreeMap::new();
            fields.insert("name".to_string(), Value::Str(name.to_string()));
            let st = match state {
                "committed" => Value::Variant {
                    type_name: "State".to_string(),
                    name: "Committed".to_string(),
                    values: vec![Value::Dur(secs)],
                },
                "arrived" => Value::Variant {
                    type_name: "State".to_string(),
                    name: "Arrived".to_string(),
                    values: vec![Value::Dur(secs)],
                },
                "interested" => Value::Variant {
                    type_name: "State".to_string(),
                    name: "Interested".to_string(),
                    values: vec![],
                },
                _ => Value::Variant {
                    type_name: "State".to_string(),
                    name: "Lurker".to_string(),
                    values: vec![],
                },
            };
            fields.insert("state".to_string(), st);
            fields.insert("engaged_for".to_string(), Value::Dur(secs));
            Value::Record {
                type_name: "Person".to_string(),
                fields,
            }
        }

        let ctx = TypeContext::default();
        let mut env = EvalEnv::default();
        env.vars.insert(
            "committed".to_string(),
            Value::List(vec![
                person("A", "committed", 60),
                person("B", "committed", 120),
                person("C", "committed", 180),
                person("D", "committed", 240),
            ]),
        );
        env.vars.insert("min_people".to_string(), Value::Num(3.0));
        env.vars.insert(
            "ready_in".to_string(),
            Value::Variant {
                type_name: "Option".to_string(),
                name: "Some".to_string(),
                values: vec![Value::Dur(300)],
            },
        );

        let compile = |src: &str| {
            let p = parse_program(src).expect("parse");
            typecheck_program(p, &ctx).expect("typecheck")
        };

        let p = compile("#committed > min_people => notify \"we have {#committed}!\"");
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(Effect::Notify {
                message: "we have 4!".to_string()
            })
        );

        let p = compile("#committed > 10 => commit");
        assert_eq!(eval_program(&p, &env).expect("eval"), None);

        let p = compile("notify \"starting in 3 min!\" before ready_in by 3min");
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(Effect::Seq {
                steps: vec![
                    Effect::Sleep { secs: 120 },
                    Effect::Notify {
                        message: "starting in 3 min!".to_string(),
                    },
                ],
            })
        );

        let p =
            compile("any (fun p -> waited p > 2min) committed => { notify \"long wait\", commit }");
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(Effect::Seq {
                steps: vec![
                    Effect::Notify {
                        message: "long wait".to_string()
                    },
                    Effect::SetState {
                        state: "committed".to_string(),
                        eta_delta_secs: None,
                    }
                ]
            })
        );

        // REPL-style expression evaluation.
        let e = parse_expr_str("avg [1, 2, 3]").expect("parse");
        assert!(matches!(eval_expr(&e, &env).expect("eval"), Value::Num(n) if n == 2.0));

        let e = parse_expr_str("max (map (fun p -> waited p) committed)").expect("parse");
        assert!(matches!(
            eval_expr(&e, &env).expect("eval"),
            Value::Dur(240)
        ));

        let e = parse_expr_str("head [5, 2, 8]").expect("parse");
        assert!(matches!(
            eval_expr(&e, &env).expect("eval"),
            Value::Variant { ref name, ref values, .. } if name == "Some" && matches!(values.as_slice(), [Value::Num(n)] if *n == 5.0)
        ));

        let e = parse_expr_str("tail [5, 2, 8]").expect("parse");
        assert!(matches!(
            eval_expr(&e, &env).expect("eval"),
            Value::List(v) if matches!(v.as_slice(), [Value::Num(a), Value::Num(b)] if *a == 2.0 && *b == 8.0)
        ));

        let e = parse_expr_str("take 3 [5, 2, 8, 1, 4]").expect("parse");
        assert!(matches!(
            eval_expr(&e, &env).expect("eval"),
            Value::List(v) if matches!(v.as_slice(), [Value::Num(a), Value::Num(b), Value::Num(c)] if *a == 5.0 && *b == 2.0 && *c == 8.0)
        ));

        let e = parse_expr_str("drop 2 [5, 2, 8, 1, 4]").expect("parse");
        assert!(matches!(
            eval_expr(&e, &env).expect("eval"),
            Value::List(v) if matches!(v.as_slice(), [Value::Num(a), Value::Num(b), Value::Num(c)] if *a == 8.0 && *b == 1.0 && *c == 4.0)
        ));

        let e = parse_expr_str("sort (fun a b -> a <= b) [5, 2, 8, 1, 4]").expect("parse");
        assert!(matches!(
            eval_expr(&e, &env).expect("eval"),
            Value::List(v) if matches!(v.as_slice(), [Value::Num(a), Value::Num(b), Value::Num(c), Value::Num(d), Value::Num(e)] if *a == 1.0 && *b == 2.0 && *c == 4.0 && *d == 5.0 && *e == 8.0)
        ));

        let e = parse_expr_str("[5, 2, 8, 1, 4][0]").expect("parse");
        assert!(matches!(eval_expr(&e, &env).expect("eval"), Value::Num(n) if n == 5.0));
    }

    #[test]
    fn rejects_type_errors() {
        let ctx = TypeContext::default();
        let bad = |src: &str| {
            let p = parse_program(src).expect("parse");
            assert!(typecheck_program(p, &ctx).is_err(), "should fail: {src}");
        };
        bad("1 + true => notify \"x\"");
        bad("#committed and true => notify \"x\"");
        bad("3 => notify \"x\"");
        bad("true => 5");
        bad("today + 1 => lurk"); // Day is not Arith
        bad("match today with | Mon -> true => lurk"); // non-exhaustive
        bad("nope > 3 => lurk"); // unknown name
        bad("notify 3 => lurk"); // notify needs Str
        bad("commit + 3");
        bad("commit - true");
        // impl method body checked against the trait signature (Str, not a list).
        bad("trait W<a> {\n  w: a -> Num\n}\nimpl W<Str> {\n  w s = #s\n}\ntrue => lurk");
    }

    #[test]
    fn json_boundary_matches_frontend() {
        use crate::ast::TypedProgram;
        use crate::eval::{Effect, EvalEnv};
        use crate::{compile_policy_with_diagnostics, evaluate_policy_safe};

        let compiled =
            compile_policy_with_diagnostics("self.name == \"A\" => notify \"hi {self.name}\"");
        assert!(compiled.diagnostics.is_empty());
        // Round-trip the policy through JSON (as the wasm boundary does).
        let policy_json = serde_json::to_string(&compiled.policy.unwrap()).unwrap();
        let policy: TypedProgram = serde_json::from_str(&policy_json).unwrap();

        // `env` encoded exactly like MathPage's buildPolicyEnv.
        let env_json = r#"{"vars":{"self":{"kind":"Record","value":{"type":"Person","fields":{
            "name":{"kind":"Str","value":"A"},
            "state":{"kind":"Variant","value":{"type":"State","name":"Lurker","values":[]}},
            "engaged_for":{"kind":"Dur","value":0}}}}}}"#;
        let env: EvalEnv = serde_json::from_str(env_json).unwrap();

        let res = evaluate_policy_safe(&policy, &env);
        assert_eq!(res.error, None);
        assert!(matches!(res.fired, Some(Effect::Notify { message }) if message == "hi A"));

        let adjusted = compile_policy_with_diagnostics("commit -3m")
            .policy
            .unwrap();
        let adjusted = evaluate_policy_safe(&adjusted, &EvalEnv::default());
        assert_eq!(
            serde_json::to_string(&adjusted.fired.unwrap()).unwrap(),
            r#"{"op":"state","state":"committed","eta_delta_secs":-180}"#
        );
    }

    #[test]
    fn user_trait_and_impl_dispatch() {
        use crate::eval::{eval_expr, EvalEnv, Value};
        let ctx = TypeContext::default();
        let src = "\
trait Weight<a> {
  weight: a -> Num
}
impl Weight<Str> {
  weight s = 3
}
impl Weight<Num> {
  weight n = n * 2
}
wa = weight \"abc\"
wn = weight 5
wa + wn > 0 => notify \"{wa} and {wn}\"";
        let p = parse_program(src).expect("parse");
        let typed = typecheck_program(p, &ctx).expect("typecheck");
        let fired = crate::eval::eval_program(&typed, &EvalEnv::default()).expect("eval");
        assert_eq!(
            fired,
            Some(crate::eval::Effect::Notify {
                message: "3 and 10".to_string()
            })
        );

        // Same, in the REPL.
        let e = parse_expr_str("Some(3)").expect("parse");
        assert!(matches!(eval_expr(&e, &EvalEnv::default()).expect("eval"),
            Value::Variant { ref name, .. } if name == "Some"));
    }

    #[test]
    fn patterns_and_effects() {
        use crate::eval::{eval_program, Effect, EvalEnv};
        let ctx = TypeContext::default();
        let compile = |src: &str| {
            let p = parse_program(src).expect("parse");
            typecheck_program(p, &ctx).expect("typecheck")
        };

        // List/option patterns + delay desugaring into a sleep + notify.
        let src = "\
first_eta xs = match xs with
  | [] -> None
  | p :: _ -> eta p
true => delay (notify \"go\") 5s";
        let p = compile(src);
        let fired = eval_program(&p, &EvalEnv::default()).expect("eval");
        assert_eq!(
            fired,
            Some(Effect::Seq {
                steps: vec![
                    Effect::Sleep { secs: 5 },
                    Effect::Notify {
                        message: "go".to_string()
                    }
                ]
            })
        );

        // if/then/else selecting an action.
        let p = compile("is_weekend today => if is_ready then commit else lurk");
        let mut env = EvalEnv::default();
        env.vars.insert(
            "today".to_string(),
            crate::eval::Value::Variant {
                type_name: "Day".to_string(),
                name: "Sat".to_string(),
                values: vec![],
            },
        );
        env.vars
            .insert("is_ready".to_string(), crate::eval::Value::Bool(false));
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(Effect::SetState {
                state: "lurker".to_string(),
                eta_delta_secs: None,
            })
        );

        let plus = eval_program(&compile("commit +3m"), &EvalEnv::default()).expect("eval");
        assert_eq!(
            plus,
            Some(Effect::SetState {
                state: "committed".to_string(),
                eta_delta_secs: Some(180),
            })
        );
        let minus = eval_program(&compile("commit -3m"), &EvalEnv::default()).expect("eval");
        assert_eq!(
            minus,
            Some(Effect::SetState {
                state: "committed".to_string(),
                eta_delta_secs: Some(-180),
            })
        );
    }
}
