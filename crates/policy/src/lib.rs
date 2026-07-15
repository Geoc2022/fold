pub mod ast;
pub mod diag;
pub mod eval;
pub mod lex;
pub mod parse;
pub mod typeck;

use ast::TypedPolicy;
use diag::Diagnostic;
use eval::{eval_policy, EvalEnv, FiredAction};
use serde::{Deserialize, Serialize};

pub fn compile_policy(source: &str) -> Result<TypedPolicy, Vec<Diagnostic>> {
    let policy = parse::parse_policy(source)?;
    typeck::typecheck_policy(policy, &typeck::TypeContext::default())
}

pub fn evaluate_policy(policy: &TypedPolicy, env: &EvalEnv) -> Result<Option<FiredAction>, String> {
    eval_policy(policy, env).map_err(|e| e.0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub policy: Option<TypedPolicy>,
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

pub fn evaluate_policy_safe(policy: &TypedPolicy, env: &EvalEnv) -> EvaluateResult {
    match evaluate_policy(policy, env) {
        Ok(fired) => EvaluateResult { fired, error: None },
        Err(error) => EvaluateResult {
            fired: None,
            error: Some(error),
        },
    }
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
                .filter(|t| !matches!(t.kind, crate::lex::TokenKind::Eof))
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
    match kind {
        crate::lex::TokenKind::Ident(_) => "ident",
        crate::lex::TokenKind::Str(_) => "string",
        crate::lex::TokenKind::Number(_) => "number",
        crate::lex::TokenKind::DurationSecs(_) => "duration",
        crate::lex::TokenKind::Hash => "hash",
        crate::lex::TokenKind::Dot => "dot",
        crate::lex::TokenKind::LParen => "lparen",
        crate::lex::TokenKind::RParen => "rparen",
        crate::lex::TokenKind::Colon => "colon",
        crate::lex::TokenKind::Comma => "comma",
        crate::lex::TokenKind::Plus => "plus",
        crate::lex::TokenKind::Minus => "minus",
        crate::lex::TokenKind::Star => "star",
        crate::lex::TokenKind::Slash => "slash",
        crate::lex::TokenKind::Percent => "percent",
        crate::lex::TokenKind::Lt => "lt",
        crate::lex::TokenKind::Lte => "lte",
        crate::lex::TokenKind::Gt => "gt",
        crate::lex::TokenKind::Gte => "gte",
        crate::lex::TokenKind::EqEq => "eqeq",
        crate::lex::TokenKind::Neq => "neq",
        crate::lex::TokenKind::FatArrow => "arrow",
        crate::lex::TokenKind::And => "and",
        crate::lex::TokenKind::Or => "or",
        crate::lex::TokenKind::Not => "not",
        crate::lex::TokenKind::Xor => "xor",
        crate::lex::TokenKind::True => "true",
        crate::lex::TokenKind::False => "false",
        crate::lex::TokenKind::Eof => "eof",
    }
}

#[cfg(feature = "wasm")]
pub mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::{
        compile_policy_with_diagnostics, evaluate_policy_safe, highlight_policy, EvalEnv,
        TypedPolicy,
    };

    #[wasm_bindgen]
    pub fn compile_policy_json(source: &str) -> String {
        match serde_json::to_string(&compile_policy_with_diagnostics(source)) {
            Ok(s) => s,
            Err(_) => "{\"policy\":null,\"diagnostics\":[{\"span\":{\"start\":0,\"end\":0},\"message\":\"serialization failed\"}]}".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn evaluate_policy_json(policy_json: &str, env_json: &str) -> String {
        let policy = match serde_json::from_str::<TypedPolicy>(policy_json) {
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

    use crate::eval::{eval_expr, eval_policy, EvalEnv, FiredAction, Value};

    use super::*;
    use crate::ast::ActionSpec;

    fn person(eta_secs: i64) -> Value {
        let mut p = HashMap::new();
        p.insert("eta".to_string(), Value::DurSecs(eta_secs));
        p.insert("arrived".to_string(), Value::Bool(false));
        p.insert("waited".to_string(), Value::DurSecs(0));
        Value::Person(p)
    }

    #[test]
    fn compiles_count_notify() {
        let p = compile_policy("3 < #committed => notify").expect("compile");
        let mut env = EvalEnv::default();
        env.vars.insert(
            "committed".into(),
            Value::List(vec![person(60), person(120), person(180), person(240)]),
        );
        let fired = eval_policy(&p, &env).expect("eval");
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
        let mut env = EvalEnv::default();
        env.vars.insert(
            "interested".into(),
            Value::List(vec![person(0), person(0), person(0), person(0)]),
        );
        let fired = eval_policy(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: Some(180)
            })
        );
    }

    #[test]
    fn compiles_combined_count_expr() {
        let p =
            compile_policy("3 < #interested + #committed => notify(after: 3min)").expect("compile");
        let mut env = EvalEnv::default();
        env.vars
            .insert("interested".into(), Value::List(vec![person(0), person(0)]));
        env.vars
            .insert("committed".into(), Value::List(vec![person(0), person(0)]));
        let fired = eval_policy(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: Some(180)
            })
        );
    }

    #[test]
    fn supports_short_notify_alias_with_message() {
        let p = compile_policy("#interested > 3 => notify \"ping\" in 3min").expect("compile");
        let mut env = EvalEnv::default();
        env.vars.insert(
            "interested".into(),
            Value::List(vec![person(0), person(0), person(0), person(0)]),
        );
        let fired = eval_policy(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: Some("ping".to_string()),
                after_secs: Some(180)
            })
        );
    }

    #[test]
    fn supports_short_notify_alias_without_message() {
        let p = compile_policy("#interested > 3 => notify in 3min").expect("compile");
        let mut env = EvalEnv::default();
        env.vars.insert(
            "interested".into(),
            Value::List(vec![person(0), person(0), person(0), person(0)]),
        );
        let fired = eval_policy(&p, &env).expect("eval");
        assert_eq!(
            fired,
            Some(FiredAction::Notify {
                message: None,
                after_secs: Some(180)
            })
        );
    }

    #[test]
    fn supports_avg_projection_expression() {
        let expr = parse::parse_policy("avg(committed.eta) > 0 => notify").expect("parse");
        let typed =
            typeck::typecheck_policy(expr, &typeck::TypeContext::default()).expect("typecheck");
        let mut env = EvalEnv::default();
        env.vars.insert(
            "committed".into(),
            Value::List(vec![person(60), person(120), person(180)]),
        );
        let cond = eval_expr(&typed.condition, &env).expect("eval expr");
        assert_eq!(cond, Value::Bool(true));
    }

    #[test]
    fn rejects_type_error() {
        let err = compile_policy("#committed and true => notify").expect_err("must fail");
        assert!(!err.is_empty());
    }

    #[test]
    fn supports_message_named_argument() {
        let p = compile_policy("#interested > 0 => notify(message: \"hello\", after: 1min)")
            .expect("compile");
        match p.action.spec {
            ActionSpec::Notify { message, after } => {
                assert_eq!(message.as_deref(), Some("hello"));
                assert!(after.is_some());
            }
        }
    }
}
