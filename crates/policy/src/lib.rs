//! # Policy DSL core
//!
//! A small, strictly-typed language for authoring notification/room policies,
//! compiled to WASM. Design decisions and their lineage:
//!
//! ## ML lineage (OCaml / Standard ML)
//! - `fun x -> body` lambdas + application by juxtaposition (OCaml surface).
//! - Hindley–Milner type inference with unification and let-polymorphism
//!   (scoped to the standard library) — Milner, *A Theory of Type Polymorphism
//!   in Programming* (1978); the Damas–Milner Algorithm W.
//! - `match` with strict exhaustiveness (a `_` arm is required unless the
//!   scrutinee type is finitely covered) — promotes ML's non-exhaustive-match
//!   warning to an error.
//! - Algebraic data: tuples, parametric `List<T>`, and user-declared nominal
//!   records (`type u = { .. }`) and variant enums (`type c = A | B`) with
//!   label-resolved record literals, field access, and destructuring — all from
//!   OCaml, including `(* nestable comments *)`.
//! - "Parse, don't validate": [`TypedProgram`] is only constructible by the
//!   type checker (ML tradition of making illegal states unrepresentable).
//!
//! ## Rust lineage
//! - Enum-based AST with exhaustive `match` in the compiler, and `Result`-style
//!   diagnostic accumulation.
//! - No implicit numeric coercions: `Num` and `Dur` are distinct; `Dur * Num`
//!   is allowed but `Dur + Num` is rejected (newtype discipline over C-style
//!   promotion).
//! - Expression-oriented evaluation; serde at the WASM/JS boundary.
//!
//! ## Deliberate divergence
//! - The off-side rule (indentation for `match` arms and statement separation)
//!   is borrowed from Python, not Rust/ML, for playground ergonomics.

pub mod ast;
pub mod diag;
pub mod eval;
pub mod lex;
pub mod parse;
pub mod typeck;

use ast::TypedProgram;
use diag::Diagnostic;
use eval::{eval_program, EvalEnv, FiredAction};
use serde::{Deserialize, Serialize};

pub fn compile_policy(source: &str) -> Result<TypedProgram, Vec<Diagnostic>> {
    let program = parse::parse_program(source)?;
    typeck::typecheck_program(program, &typeck::TypeContext::default())
}

pub fn evaluate_policy(program: &TypedProgram, env: &EvalEnv) -> Result<Option<FiredAction>, String> {
    eval_program(program, env).map_err(|e| e.0)
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
        Err(diags) => CompileResult {
            policy: None,
            diagnostics: diags,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluateResult {
    pub fired: Option<FiredAction>,
    pub error: Option<String>,
}

pub fn evaluate_policy_safe(policy: &TypedProgram, env: &EvalEnv) -> EvaluateResult {
    match evaluate_policy(policy, env) {
        Ok(fired) => EvaluateResult { fired, error: None },
        Err(error) => EvaluateResult {
            fired: None,
            error: Some(error),
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
    let ty = match typeck::typecheck_expr(&expr, &typeck::TypeContext::default()) {
        Ok(t) => t,
        Err(diags) => {
            return EvalExprResult {
                output: None,
                ty: None,
                error: Some(first_message(&diags, "type error")),
            }
        }
    };
    match eval::eval_expr(&expr, &env.vars) {
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
                .filter(|t| {
                    !matches!(
                        t.kind,
                        crate::lex::TokenKind::Eof
                            | crate::lex::TokenKind::Newline
                            | crate::lex::TokenKind::Indent
                            | crate::lex::TokenKind::Dedent
                    )
                })
                .map(|t| HighlightToken {
                    kind: token_kind_name(&t.kind).to_string(),
                    start: t.span.start,
                    end: t.span.end,
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

fn token_kind_name(kind: &crate::lex::TokenKind) -> &'static str {
    use crate::lex::TokenKind as T;
    match kind {
        T::Ident(_) => "ident",
        T::Str(_) => "string",
        T::Number(_) => "number",
        T::DurationSecs(_) => "duration",
        T::Hash => "hash",
        T::Dot => "dot",
        T::LParen => "lparen",
        T::RParen => "rparen",
        T::Colon => "colon",
        T::Comma => "comma",
        T::Plus => "plus",
        T::Minus => "minus",
        T::Star => "star",
        T::Slash => "slash",
        T::Percent => "percent",
        T::Lt => "lt",
        T::Lte => "lte",
        T::Gt => "gt",
        T::Gte => "gte",
        T::EqEq => "eqeq",
        T::Neq => "neq",
        T::Eq => "eq",
        T::FatArrow => "arrow",
        T::Arrow => "thinarrow",
        T::LBrace => "lbrace",
        T::RBrace => "rbrace",
        T::Pipe => "pipe",
        T::Semi => "semi",
        T::Type => "type",
        T::And => "and",
        T::Or => "or",
        T::Not => "not",
        T::Xor => "xor",
        T::True => "true",
        T::False => "false",
        T::Fun => "fun",
        T::Match => "match",
        T::Underscore => "wildcard",
        T::Newline => "newline",
        T::Indent => "indent",
        T::Dedent => "dedent",
        T::Eof => "eof",
    }
}

#[cfg(feature = "wasm")]
pub mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::{
        compile_policy_with_diagnostics, evaluate_expression, evaluate_policy_safe,
        highlight_policy, EvalEnv, TypedProgram,
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
        match serde_json::to_string(&evaluate_expression(source, &env)) {
            Ok(s) => s,
            Err(_) => "{\"output\":null,\"ty\":null,\"error\":\"serialization failed\"}".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn compile_policy_json(source: &str) -> String {
        match serde_json::to_string(&compile_policy_with_diagnostics(source)) {
            Ok(s) => s,
            Err(_) => "{\"policy\":null,\"diagnostics\":[{\"span\":{\"start\":0,\"end\":0},\"message\":\"serialization failed\"}]}".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn evaluate_policy_json(policy_json: &str, env_json: &str) -> String {
        let policy = match serde_json::from_str::<TypedProgram>(policy_json) {
            Ok(p) => p,
            Err(e) => {
                return format!(
                    "{{\"fired\":null,\"error\":\"invalid policy json: {}\"}}",
                    e
                )
            }
        };
        let env = match serde_json::from_str::<EvalEnv>(env_json) {
            Ok(v) => v,
            Err(e) => return format!("{{\"fired\":null,\"error\":\"invalid env json: {}\"}}", e),
        };
        match serde_json::to_string(&evaluate_policy_safe(&policy, &env)) {
            Ok(s) => s,
            Err(_) => "{\"fired\":null,\"error\":\"serialization failed\"}".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn highlight_policy_json(source: &str) -> String {
        match serde_json::to_string(&highlight_policy(source)) {
            Ok(s) => s,
            Err(_) => "{\"tokens\":[],\"diagnostics\":[{\"span\":{\"start\":0,\"end\":0},\"message\":\"serialization failed\"}]}".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::eval::{eval_expr, eval_program, EvalEnv, FiredAction, Value};

    use super::*;
    use crate::ast::ActionSpec;

    fn named(name: &str, secs: i64) -> Value {
        Value::Tuple(vec![Value::Str(name.to_string()), Value::DurSecs(secs)])
    }

    fn env_with(vars: &[(&str, Value)]) -> EvalEnv {
        let mut env = EvalEnv::default();
        for (k, v) in vars {
            env.vars.insert((*k).to_string(), v.clone());
        }
        env
    }

    #[test]
    fn compiles_count_notify() {
        let p = compile_policy("3 < #committed => notify").expect("compile");
        let env = env_with(&[(
            "committed",
            Value::List(vec![named("A", 60), named("B", 120), named("C", 180), named("D", 240)]),
        )]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: None
            })
        );
    }

    #[test]
    fn compiles_delayed_notify() {
        let p = compile_policy("3 < #interested => notify(after: 3min)").expect("compile");
        let env = env_with(&[(
            "interested",
            Value::List(vec![
                Value::Str("A".into()),
                Value::Str("B".into()),
                Value::Str("C".into()),
                Value::Str("D".into()),
            ]),
        )]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: Some(180)
            })
        );
    }

    #[test]
    fn short_notify_alias_with_message() {
        let p = compile_policy("#interested > 3 => notify \"ping\" in 3min").expect("compile");
        let env = env_with(&[(
            "interested",
            Value::List(vec![
                Value::Str("A".into()),
                Value::Str("B".into()),
                Value::Str("C".into()),
                Value::Str("D".into()),
            ]),
        )]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: Some("ping".to_string()),
                after_secs: Some(180)
            })
        );
    }

    #[test]
    fn compound_duration_notify() {
        let p = compile_policy("#interested > 0 => notify in 1m2s").expect("compile");
        let env = env_with(&[("interested", Value::List(vec![Value::Str("A".into())]))]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: Some(62)
            })
        );
    }

    #[test]
    fn proj_and_avg_over_committed() {
        // proj(committed).1 is List<Dur>; avg over durations returns Dur.
        let p = compile_policy("avg(proj(committed).1) > 1min => notify").expect("compile");
        let env = env_with(&[(
            "committed",
            Value::List(vec![named("A", 60), named("B", 120), named("C", 180)]),
        )]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: None
            })
        );
    }

    #[test]
    fn lambda_application() {
        let expr = parse::parse_program("(fun x -> x * 2) 4 > 7 => notify")
            .expect("parse");
        let typed = typeck::typecheck_program(expr, &typeck::TypeContext::default())
            .expect("typecheck");
        let env = EvalEnv::default();
        let fired = eval_program(&typed, &env).expect("eval");
        assert!(matches!(fired, Some(FiredAction::Notify { .. })));
    }

    #[test]
    fn map_filter_any() {
        let src = "any(fun c -> c > 2min, proj(committed).1) => commit";
        let p = compile_policy(src).expect("compile");
        let env = env_with(&[(
            "committed",
            Value::List(vec![named("A", 60), named("B", 200)]),
        )]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(fired, Some(FiredAction::Commit));
    }

    #[test]
    fn bindings_are_usable() {
        let src = "a = 3\nb = #interested\nb > a => interest";
        let p = compile_policy(src).expect("compile");
        let env = env_with(&[(
            "interested",
            Value::List(vec![
                Value::Str("A".into()),
                Value::Str("B".into()),
                Value::Str("C".into()),
                Value::Str("D".into()),
            ]),
        )]);
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(fired, Some(FiredAction::Interest));
    }

    #[test]
    fn match_expression_strict() {
        let src = "a = 2\nmatch a\n  1 => false\n  2 => true\n  _ => false\n=> lurk";
        let p = compile_policy(src).expect("compile");
        let env = EvalEnv::default();
        let fired = eval_program(&p, &env).expect("eval");
        assert_eq!(fired, Some(FiredAction::Lurk));
    }

    #[test]
    fn match_requires_exhaustive() {
        let src = "a = 2\nmatch a\n  1 => true\n  2 => false\n=> notify";
        let err = compile_policy(src).expect_err("must require wildcard");
        assert!(!err.is_empty());
    }

    #[test]
    fn match_arms_must_agree() {
        let src = "match 1\n  1 => true\n  _ => 3\n=> notify";
        let err = compile_policy(src).expect_err("mismatched arm types");
        assert!(!err.is_empty());
    }

    #[test]
    fn rejects_type_error() {
        let err = compile_policy("#committed and true => notify").expect_err("must fail");
        assert!(!err.is_empty());
    }

    #[test]
    fn message_named_argument() {
        let p = compile_policy("#interested > 0 => notify(message: \"hello\", after: 1min)")
            .expect("compile");
        match p.action.spec {
            ActionSpec::Notify { message, after } => {
                assert_eq!(message.as_deref(), Some("hello"));
                assert!(after.is_some());
            }
            _ => panic!("expected notify"),
        }
    }

    #[test]
    fn record_type_field_access_and_destructuring() {
        let src = "\
type user = { id : int; name : string; email : string }
account = { id = 1; name = \"Alice\"; email = \"a@x.com\" }
{ name; _ } = account
name == \"Alice\" and account.id > 0 => notify \"ok\" in 3s";
        let p = compile_policy(src).expect("compile");
        let fired = eval_program(&p, &EvalEnv::default()).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: Some("ok".to_string()),
                after_secs: Some(3)
            })
        );
    }

    #[test]
    fn record_multiline_and_comments() {
        let src = "\
(* a record type *)
type user = {
  id : int
  name : string
}
account = {
  id = 7
  name = \"Bo\"
}
account.id == 7 => notify";
        let p = compile_policy(src).expect("compile");
        let fired = eval_program(&p, &EvalEnv::default()).expect("eval");
        assert!(matches!(fired, Some(FiredAction::Notify { .. })));
    }

    #[test]
    fn enum_match_exhaustive() {
        let src = "\
type color = Red | Green | Blue
c = Green
match c
  Red => false
  Green => true
  Blue => false
=> commit";
        let p = compile_policy(src).expect("compile");
        let fired = eval_program(&p, &EvalEnv::default()).expect("eval");
        assert_eq!(fired, Some(FiredAction::Commit));
    }

    #[test]
    fn enum_match_non_exhaustive_rejected() {
        let src = "\
type color = Red | Green | Blue
c = Red
match c
  Red => true
  Green => false
=> notify";
        let err = compile_policy(src).expect_err("must require all variants or '_'");
        assert!(!err.is_empty());
    }

    #[test]
    fn record_wrong_field_type_rejected() {
        let src = "\
type user = { id : int; name : string }
account = { id = \"nope\"; name = \"Alice\" }
account.id > 0 => notify";
        let err = compile_policy(src).expect_err("id must be Num");
        assert!(!err.is_empty());
    }

    #[test]
    fn evaluate_expression_terminal() {
        let env = env_with(&[(
            "committed",
            Value::List(vec![named("A", 60), named("B", 120)]),
        )]);
        let r = evaluate_expression("avg(proj(committed).1)", &env);
        assert_eq!(r.error, None);
        assert_eq!(r.output.as_deref(), Some("1m30s"));
        assert_eq!(r.ty.as_deref(), Some("Dur"));

        let arith = evaluate_expression("(fun x -> x * 2) 4 + 1", &EvalEnv::default());
        assert_eq!(arith.output.as_deref(), Some("9"));
        assert_eq!(arith.ty.as_deref(), Some("Num"));

        let bad = evaluate_expression("1 + true", &EvalEnv::default());
        assert!(bad.error.is_some());
    }

    #[test]
    fn string_equality_in_condition() {
        let expr = parse::parse_program("\"a\" == \"a\" => interest").expect("parse");
        let typed = typeck::typecheck_program(expr, &typeck::TypeContext::default())
            .expect("typecheck");
        let cond = eval_expr(&typed.condition, &HashMap::new()).expect("eval");
        assert_eq!(cond, Value::Bool(true));
    }
}
