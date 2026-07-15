use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::ast::{
    ActionSpec, BinaryOp, Binding, Decl, Expr, MatchArm, Pattern, TypedProgram, UnaryOp,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Num(f64),
    Bool(bool),
    DurSecs(i64),
    Str(String),
    List(Vec<Value>),
    Tuple(Vec<Value>),
    Record(HashMap<String, Value>),
    Variant(String),
    Closure {
        param: String,
        body: Box<Expr>,
        env: HashMap<String, Value>,
    },
    Builtin(String),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EvalEnv {
    pub vars: HashMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FiredAction {
    Notify {
        message: Option<String>,
        after_secs: Option<i64>,
    },
    Commit,
    Interest,
    Lurk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalError(pub String);

/// Human-readable rendering of a value (used by the terminal/REPL).
pub fn format_value(value: &Value) -> String {
    match value {
        Value::Num(n) => format_num(*n),
        Value::Bool(b) => b.to_string(),
        Value::DurSecs(s) => format_dur(*s),
        Value::Str(s) => format!("\"{s}\""),
        Value::List(items) => {
            let inner: Vec<String> = items.iter().map(format_value).collect();
            format!("[{}]", inner.join(", "))
        }
        Value::Tuple(items) => {
            let inner: Vec<String> = items.iter().map(format_value).collect();
            format!("({})", inner.join(", "))
        }
        Value::Record(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| format!("{k} = {}", format_value(&map[*k])))
                .collect();
            format!("{{ {} }}", inner.join("; "))
        }
        Value::Variant(name) => name.clone(),
        Value::Closure { .. } => "<fun>".to_string(),
        Value::Builtin(name) => format!("<builtin {name}>"),
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn format_dur(total: i64) -> String {
    if total == 0 {
        return "0s".to_string();
    }
    let neg = total < 0;
    let mut secs = total.abs();
    let h = secs / 3600;
    secs %= 3600;
    let m = secs / 60;
    secs %= 60;
    let mut out = String::new();
    if h > 0 {
        out.push_str(&format!("{h}h"));
    }
    if m > 0 {
        out.push_str(&format!("{m}m"));
    }
    if secs > 0 {
        out.push_str(&format!("{secs}s"));
    }
    if neg {
        format!("-{out}")
    } else {
        out
    }
}

pub fn eval_program(
    program: &TypedProgram,
    env: &EvalEnv,
) -> Result<Option<FiredAction>, EvalError> {
    let mut vars = env.vars.clone();
    // Inject enum variants as values so bare `Red` resolves like a constructor.
    for decl in &program.decls {
        if let Decl::Enum { variants, .. } = decl {
            for v in variants {
                vars.insert(v.clone(), Value::Variant(v.clone()));
            }
        }
    }
    for binding in &program.bindings {
        match binding {
            Binding::Simple { name, value } => {
                let v = eval_expr(value, &vars)?;
                vars.insert(name.clone(), v);
            }
            Binding::Record { fields, value, .. } => {
                let v = eval_expr(value, &vars)?;
                match v {
                    Value::Record(map) => {
                        for f in fields {
                            let fv = map.get(f).cloned().ok_or_else(|| {
                                EvalError(format!("record has no field '{f}'"))
                            })?;
                            vars.insert(f.clone(), fv);
                        }
                    }
                    _ => return Err(EvalError("destructuring requires a record".into())),
                }
            }
        }
    }

    let cond = eval_expr(&program.condition, &vars)?;
    match cond {
        Value::Bool(false) => Ok(None),
        Value::Bool(true) => match &program.action.spec {
            ActionSpec::Notify { message, after } => {
                let after_secs = match after {
                    Some(expr) => match eval_expr(expr, &vars)? {
                        Value::DurSecs(s) => Some(s.max(0)),
                        _ => {
                            return Err(EvalError(
                                "notify(after) must evaluate to duration".into(),
                            ))
                        }
                    },
                    None => None,
                };
                Ok(Some(FiredAction::Notify {
                    message: message.clone(),
                    after_secs,
                }))
            }
            ActionSpec::Commit => Ok(Some(FiredAction::Commit)),
            ActionSpec::Interest => Ok(Some(FiredAction::Interest)),
            ActionSpec::Lurk => Ok(Some(FiredAction::Lurk)),
        },
        _ => Err(EvalError("condition did not evaluate to Bool".into())),
    }
}

fn is_builtin(name: &str) -> bool {
    matches!(
        name,
        "len" | "map"
            | "filter"
            | "any"
            | "all"
            | "proj"
            | "sum"
            | "avg"
            | "min"
            | "max"
            | "abs"
            | "floor"
            | "ceil"
            | "round"
    )
}

pub fn eval_expr(expr: &Expr, vars: &HashMap<String, Value>) -> Result<Value, EvalError> {
    match expr {
        Expr::Num(n) => Ok(Value::Num(*n)),
        Expr::Bool(b) => Ok(Value::Bool(*b)),
        Expr::Str(s) => Ok(Value::Str(s.clone())),
        Expr::DurationSecs(s) => Ok(Value::DurSecs(*s)),
        Expr::Var(name) => {
            if let Some(v) = vars.get(name) {
                Ok(v.clone())
            } else if is_builtin(name) {
                Ok(Value::Builtin(name.clone()))
            } else {
                Err(EvalError(format!("missing variable '{name}'")))
            }
        }
        Expr::Count(name) => match vars.get(name) {
            Some(Value::List(xs)) => Ok(Value::Num(xs.len() as f64)),
            Some(_) => Err(EvalError(format!("'#{name}' expects a list"))),
            None => Err(EvalError(format!("missing list variable '{name}'"))),
        },
        Expr::Tuple(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                out.push(eval_expr(it, vars)?);
            }
            Ok(Value::Tuple(out))
        }
        Expr::Unary { op, expr } => {
            let v = eval_expr(expr, vars)?;
            match (op, v) {
                (UnaryOp::Not, Value::Bool(b)) => Ok(Value::Bool(!b)),
                (UnaryOp::Neg, Value::Num(n)) => Ok(Value::Num(-n)),
                (UnaryOp::Neg, Value::DurSecs(s)) => Ok(Value::DurSecs(-s)),
                _ => Err(EvalError("invalid unary operation".into())),
            }
        }
        Expr::Binary { op, left, right } => {
            let l = eval_expr(left, vars)?;
            let r = eval_expr(right, vars)?;
            eval_binary(*op, l, r)
        }
        Expr::Apply { func, arg } => {
            let f = eval_expr(func, vars)?;
            let a = eval_expr(arg, vars)?;
            apply_value(f, a)
        }
        Expr::Lambda { param, body } => Ok(Value::Closure {
            param: param.clone(),
            body: body.clone(),
            env: vars.clone(),
        }),
        Expr::Match { scrutinee, arms } => {
            let v = eval_expr(scrutinee, vars)?;
            eval_match(&v, arms, vars)
        }
        Expr::TupleIndex { base, index } => {
            let b = eval_expr(base, vars)?;
            match b {
                Value::Tuple(items) => items
                    .get(*index)
                    .cloned()
                    .ok_or_else(|| EvalError(format!("tuple index {index} out of range"))),
                _ => Err(EvalError("tuple index requires a tuple".into())),
            }
        }
        Expr::Record { fields } => {
            let mut map = HashMap::with_capacity(fields.len());
            for (name, expr) in fields {
                map.insert(name.clone(), eval_expr(expr, vars)?);
            }
            Ok(Value::Record(map))
        }
        Expr::Field { base, field } => {
            let b = eval_expr(base, vars)?;
            match b {
                Value::Record(map) => map
                    .get(field)
                    .cloned()
                    .ok_or_else(|| EvalError(format!("record has no field '{field}'"))),
                _ => Err(EvalError("field access requires a record".into())),
            }
        }
    }
}

fn eval_match(
    value: &Value,
    arms: &[MatchArm],
    vars: &HashMap<String, Value>,
) -> Result<Value, EvalError> {
    for arm in arms {
        if pattern_matches(&arm.pattern, value) {
            return eval_expr(&arm.body, vars);
        }
    }
    Err(EvalError("no match arm matched (non-exhaustive)".into()))
}

fn pattern_matches(pattern: &Pattern, value: &Value) -> bool {
    match (pattern, value) {
        (Pattern::Wildcard, _) => true,
        (Pattern::Num(a), Value::Num(b)) => (a - b).abs() < f64::EPSILON,
        (Pattern::Bool(a), Value::Bool(b)) => a == b,
        (Pattern::Str(a), Value::Str(b)) => a == b,
        (Pattern::Dur(a), Value::DurSecs(b)) => a == b,
        (Pattern::Variant(a), Value::Variant(b)) => a == b,
        _ => false,
    }
}

fn apply_value(func: Value, arg: Value) -> Result<Value, EvalError> {
    match func {
        Value::Closure { param, body, env } => {
            let mut inner = env;
            inner.insert(param, arg);
            eval_expr(&body, &inner)
        }
        Value::Builtin(name) => eval_builtin(&name, arg),
        _ => Err(EvalError("attempted to call a non-function value".into())),
    }
}

fn eval_builtin(name: &str, arg: Value) -> Result<Value, EvalError> {
    match name {
        "len" => match arg {
            Value::List(xs) => Ok(Value::Num(xs.len() as f64)),
            _ => Err(EvalError("len(list) expects a list".into())),
        },
        "sum" => match arg {
            Value::List(xs) => sum_list(&xs),
            _ => Err(EvalError("sum(list) expects a list".into())),
        },
        "avg" => match arg {
            Value::List(xs) => {
                if xs.is_empty() {
                    return Ok(Value::Num(0.0));
                }
                let total = sum_list(&xs)?;
                let n = xs.len() as f64;
                match total {
                    Value::Num(t) => Ok(Value::Num(t / n)),
                    Value::DurSecs(t) => Ok(Value::DurSecs((t as f64 / n).round() as i64)),
                    _ => Err(EvalError("avg(list) expects numbers or durations".into())),
                }
            }
            _ => Err(EvalError("avg(list) expects a list".into())),
        },
        "min" => match arg {
            Value::Tuple(items) if items.len() == 2 => match (&items[0], &items[1]) {
                (Value::Num(a), Value::Num(b)) => Ok(Value::Num(a.min(*b))),
                (Value::DurSecs(a), Value::DurSecs(b)) => Ok(Value::DurSecs((*a).min(*b))),
                _ => Err(EvalError("min(a, b) expects matching Num or Dur".into())),
            },
            _ => Err(EvalError("min(a, b) expects two arguments".into())),
        },
        "max" => match arg {
            Value::Tuple(items) if items.len() == 2 => match (&items[0], &items[1]) {
                (Value::Num(a), Value::Num(b)) => Ok(Value::Num(a.max(*b))),
                (Value::DurSecs(a), Value::DurSecs(b)) => Ok(Value::DurSecs((*a).max(*b))),
                _ => Err(EvalError("max(a, b) expects matching Num or Dur".into())),
            },
            _ => Err(EvalError("max(a, b) expects two arguments".into())),
        },
        "abs" => match arg {
            Value::Num(a) => Ok(Value::Num(a.abs())),
            _ => Err(EvalError("abs(x) expects a number".into())),
        },
        "floor" => match arg {
            Value::Num(a) => Ok(Value::Num(a.floor())),
            _ => Err(EvalError("floor(x) expects a number".into())),
        },
        "ceil" => match arg {
            Value::Num(a) => Ok(Value::Num(a.ceil())),
            _ => Err(EvalError("ceil(x) expects a number".into())),
        },
        "round" => match arg {
            Value::Num(a) => Ok(Value::Num(a.round())),
            _ => Err(EvalError("round(x) expects a number".into())),
        },
        "map" => {
            let (f, xs) = pair_fn_list(arg, "map")?;
            let mut out = Vec::with_capacity(xs.len());
            for x in xs {
                out.push(apply_value(f.clone(), x)?);
            }
            Ok(Value::List(out))
        }
        "filter" => {
            let (f, xs) = pair_fn_list(arg, "filter")?;
            let mut out = Vec::new();
            for x in xs {
                if as_bool(apply_value(f.clone(), x.clone())?, "filter")? {
                    out.push(x);
                }
            }
            Ok(Value::List(out))
        }
        "any" => {
            let (f, xs) = pair_fn_list(arg, "any")?;
            for x in xs {
                if as_bool(apply_value(f.clone(), x)?, "any")? {
                    return Ok(Value::Bool(true));
                }
            }
            Ok(Value::Bool(false))
        }
        "all" => {
            let (f, xs) = pair_fn_list(arg, "all")?;
            for x in xs {
                if !as_bool(apply_value(f.clone(), x)?, "all")? {
                    return Ok(Value::Bool(false));
                }
            }
            Ok(Value::Bool(true))
        }
        "proj" => match arg {
            Value::List(items) => {
                let mut firsts = Vec::with_capacity(items.len());
                let mut seconds = Vec::with_capacity(items.len());
                for it in items {
                    match it {
                        Value::Tuple(t) if t.len() == 2 => {
                            firsts.push(t[0].clone());
                            seconds.push(t[1].clone());
                        }
                        _ => {
                            return Err(EvalError(
                                "proj expects a list of 2-tuples".into(),
                            ))
                        }
                    }
                }
                Ok(Value::Tuple(vec![Value::List(firsts), Value::List(seconds)]))
            }
            _ => Err(EvalError("proj expects a list of tuples".into())),
        },
        _ => Err(EvalError(format!("unknown builtin '{name}'"))),
    }
}

fn pair_fn_list(arg: Value, who: &str) -> Result<(Value, Vec<Value>), EvalError> {
    match arg {
        Value::Tuple(mut items) if items.len() == 2 => {
            let list = items.pop().unwrap();
            let f = items.pop().unwrap();
            match list {
                Value::List(xs) => Ok((f, xs)),
                _ => Err(EvalError(format!("{who}(f, list) expects a list"))),
            }
        }
        _ => Err(EvalError(format!("{who}(f, list) expects (function, list)"))),
    }
}

fn as_bool(v: Value, who: &str) -> Result<bool, EvalError> {
    match v {
        Value::Bool(b) => Ok(b),
        _ => Err(EvalError(format!("{who} predicate must return Bool"))),
    }
}

fn sum_list(xs: &[Value]) -> Result<Value, EvalError> {
    let mut is_dur = false;
    let mut total = 0.0;
    for v in xs {
        match v {
            Value::Num(n) => total += n,
            Value::DurSecs(s) => {
                is_dur = true;
                total += *s as f64;
            }
            _ => {
                return Err(EvalError(
                    "sum/avg expect a list of numbers or durations".into(),
                ))
            }
        }
    }
    if is_dur {
        Ok(Value::DurSecs(total.round() as i64))
    } else {
        Ok(Value::Num(total))
    }
}

fn eval_binary(op: BinaryOp, l: Value, r: Value) -> Result<Value, EvalError> {
    match op {
        BinaryOp::Add => match (l, r) {
            (Value::Num(a), Value::Num(b)) => Ok(Value::Num(a + b)),
            (Value::DurSecs(a), Value::DurSecs(b)) => Ok(Value::DurSecs(a + b)),
            _ => Err(EvalError("'+' requires Num+Num or Dur+Dur".into())),
        },
        BinaryOp::Sub => match (l, r) {
            (Value::Num(a), Value::Num(b)) => Ok(Value::Num(a - b)),
            (Value::DurSecs(a), Value::DurSecs(b)) => Ok(Value::DurSecs(a - b)),
            _ => Err(EvalError("'-' requires Num-Num or Dur-Dur".into())),
        },
        BinaryOp::Mul => match (l, r) {
            (Value::Num(a), Value::Num(b)) => Ok(Value::Num(a * b)),
            (Value::DurSecs(a), Value::Num(b)) => Ok(Value::DurSecs((a as f64 * b).round() as i64)),
            (Value::Num(a), Value::DurSecs(b)) => Ok(Value::DurSecs((a * b as f64).round() as i64)),
            _ => Err(EvalError("'*' requires Num*Num or Dur*Num".into())),
        },
        BinaryOp::Div => match (l, r) {
            (Value::Num(a), Value::Num(b)) => Ok(Value::Num(if b == 0.0 { 0.0 } else { a / b })),
            (Value::DurSecs(a), Value::Num(b)) => Ok(Value::DurSecs(if b == 0.0 {
                0
            } else {
                (a as f64 / b).round() as i64
            })),
            _ => Err(EvalError("'/' requires Num/Num or Dur/Num".into())),
        },
        BinaryOp::Mod => match (l, r) {
            (Value::Num(a), Value::Num(b)) => Ok(Value::Num(if b == 0.0 { 0.0 } else { a % b })),
            _ => Err(EvalError("'%' requires Num%Num".into())),
        },
        BinaryOp::Lt
        | BinaryOp::Lte
        | BinaryOp::Gt
        | BinaryOp::Gte
        | BinaryOp::Eq
        | BinaryOp::Neq => eval_compare(op, l, r),
        BinaryOp::And | BinaryOp::Or | BinaryOp::Xor => match (l, r) {
            (Value::Bool(a), Value::Bool(b)) => Ok(Value::Bool(match op {
                BinaryOp::And => a && b,
                BinaryOp::Or => a || b,
                BinaryOp::Xor => a ^ b,
                _ => false,
            })),
            _ => Err(EvalError("logical operations require booleans".into())),
        },
    }
}

fn eval_compare(op: BinaryOp, l: Value, r: Value) -> Result<Value, EvalError> {
    match (l, r) {
        (Value::Num(a), Value::Num(b)) => Ok(Value::Bool(match op {
            BinaryOp::Lt => a < b,
            BinaryOp::Lte => a <= b,
            BinaryOp::Gt => a > b,
            BinaryOp::Gte => a >= b,
            BinaryOp::Eq => (a - b).abs() < f64::EPSILON,
            BinaryOp::Neq => (a - b).abs() >= f64::EPSILON,
            _ => false,
        })),
        (Value::DurSecs(a), Value::DurSecs(b)) => Ok(Value::Bool(match op {
            BinaryOp::Lt => a < b,
            BinaryOp::Lte => a <= b,
            BinaryOp::Gt => a > b,
            BinaryOp::Gte => a >= b,
            BinaryOp::Eq => a == b,
            BinaryOp::Neq => a != b,
            _ => false,
        })),
        (Value::Bool(a), Value::Bool(b)) => Ok(Value::Bool(match op {
            BinaryOp::Eq => a == b,
            BinaryOp::Neq => a != b,
            _ => return Err(EvalError("only ==/!= supported for booleans".into())),
        })),
        (Value::Str(a), Value::Str(b)) => Ok(Value::Bool(match op {
            BinaryOp::Eq => a == b,
            BinaryOp::Neq => a != b,
            _ => return Err(EvalError("only ==/!= supported for strings".into())),
        })),
        (Value::Variant(a), Value::Variant(b)) => Ok(Value::Bool(match op {
            BinaryOp::Eq => a == b,
            BinaryOp::Neq => a != b,
            _ => return Err(EvalError("only ==/!= supported for variants".into())),
        })),
        _ => Err(EvalError(
            "comparison operands must have matching types".into(),
        )),
    }
}
