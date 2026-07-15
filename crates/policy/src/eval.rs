use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::ast::{ActionSpec, BinaryOp, Expr, TypedPolicy, UnaryOp};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Num(f64),
    Bool(bool),
    DurSecs(i64),
    List(Vec<Value>),
    Person(HashMap<String, Value>),
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalError(pub String);

pub fn eval_policy(policy: &TypedPolicy, env: &EvalEnv) -> Result<Option<FiredAction>, EvalError> {
    let cond = eval_expr(&policy.condition, env)?;
    match cond {
        Value::Bool(false) => Ok(None),
        Value::Bool(true) => match &policy.action.spec {
            ActionSpec::Notify { message, after } => {
                let after_secs = match after {
                    Some(expr) => match eval_expr(expr, env)? {
                        Value::DurSecs(s) => Some(s.max(0)),
                        _ => {
                            return Err(EvalError("notify(after) must evaluate to duration".into()))
                        }
                    },
                    None => None,
                };
                Ok(Some(FiredAction::Notify {
                    message: message.clone(),
                    after_secs,
                }))
            }
        },
        _ => Err(EvalError("condition did not evaluate to Bool".into())),
    }
}

pub fn eval_expr(expr: &Expr, env: &EvalEnv) -> Result<Value, EvalError> {
    match expr {
        Expr::Num(n) => Ok(Value::Num(*n)),
        Expr::Bool(b) => Ok(Value::Bool(*b)),
        Expr::DurationSecs(s) => Ok(Value::DurSecs(*s)),
        Expr::Var(name) => env
            .vars
            .get(name)
            .cloned()
            .ok_or_else(|| EvalError(format!("missing variable '{name}'"))),
        Expr::Count(name) => match env.vars.get(name) {
            Some(Value::List(xs)) => Ok(Value::Num(xs.len() as f64)),
            Some(_) => Err(EvalError(format!("'#{}' expects a list", name))),
            None => Err(EvalError(format!("missing list variable '{name}'"))),
        },
        Expr::Unary { op, expr } => {
            let v = eval_expr(expr, env)?;
            match (op, v) {
                (UnaryOp::Not, Value::Bool(b)) => Ok(Value::Bool(!b)),
                (UnaryOp::Neg, Value::Num(n)) => Ok(Value::Num(-n)),
                (UnaryOp::Neg, Value::DurSecs(s)) => Ok(Value::DurSecs(-s)),
                _ => Err(EvalError("invalid unary operation".into())),
            }
        }
        Expr::Binary { op, left, right } => {
            let l = eval_expr(left, env)?;
            let r = eval_expr(right, env)?;
            eval_binary(*op, l, r)
        }
        Expr::Call { name, args } => {
            let values: Result<Vec<_>, _> = args.iter().map(|a| eval_expr(a, env)).collect();
            eval_call(name, &values?)
        }
        Expr::Field { base, field } => {
            let base_v = eval_expr(base, env)?;
            match base_v {
                Value::Person(person) => person
                    .get(field)
                    .cloned()
                    .ok_or_else(|| EvalError(format!("person field '{field}' not found"))),
                Value::List(items) => {
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        match item {
                            Value::Person(person) => {
                                let v = person.get(field).cloned().ok_or_else(|| {
                                    EvalError(format!("person field '{field}' not found"))
                                })?;
                                out.push(v);
                            }
                            _ => {
                                return Err(EvalError(
                                    "field projection expects a list of person records".into(),
                                ))
                            }
                        }
                    }
                    Ok(Value::List(out))
                }
                _ => Err(EvalError("field access requires person or list".into())),
            }
        }
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
        _ => Err(EvalError(
            "comparison operands must have matching types".into(),
        )),
    }
}

fn eval_call(name: &str, args: &[Value]) -> Result<Value, EvalError> {
    match name {
        "len" => match args {
            [Value::List(xs)] => Ok(Value::Num(xs.len() as f64)),
            _ => Err(EvalError("len(list) expects one list argument".into())),
        },
        "sum" => match args {
            [Value::List(xs)] => {
                let mut total = 0.0;
                for v in xs {
                    match v {
                        Value::Num(n) => total += n,
                        Value::DurSecs(s) => total += *s as f64,
                        _ => {
                            return Err(EvalError(
                                "sum(list) expects list of numbers or durations".into(),
                            ))
                        }
                    }
                }
                Ok(Value::Num(total))
            }
            _ => Err(EvalError("sum(list) expects one list argument".into())),
        },
        "avg" => match args {
            [Value::List(xs)] => {
                if xs.is_empty() {
                    return Ok(Value::Num(0.0));
                }
                let mut total = 0.0;
                for v in xs {
                    match v {
                        Value::Num(n) => total += n,
                        Value::DurSecs(s) => total += *s as f64,
                        _ => {
                            return Err(EvalError(
                                "avg(list) expects list of numbers or durations".into(),
                            ))
                        }
                    }
                }
                Ok(Value::Num(total / xs.len() as f64))
            }
            _ => Err(EvalError("avg(list) expects one list argument".into())),
        },
        "min" => match args {
            [Value::Num(a), Value::Num(b)] => Ok(Value::Num(a.min(*b))),
            [Value::DurSecs(a), Value::DurSecs(b)] => Ok(Value::DurSecs((*a).min(*b))),
            _ => Err(EvalError(
                "min(a,b) expects matching Num or Dur args".into(),
            )),
        },
        "max" => match args {
            [Value::Num(a), Value::Num(b)] => Ok(Value::Num(a.max(*b))),
            [Value::DurSecs(a), Value::DurSecs(b)] => Ok(Value::DurSecs((*a).max(*b))),
            _ => Err(EvalError(
                "max(a,b) expects matching Num or Dur args".into(),
            )),
        },
        "abs" => match args {
            [Value::Num(a)] => Ok(Value::Num(a.abs())),
            _ => Err(EvalError("abs(x) expects one number".into())),
        },
        "floor" => match args {
            [Value::Num(a)] => Ok(Value::Num(a.floor())),
            _ => Err(EvalError("floor(x) expects one number".into())),
        },
        "ceil" => match args {
            [Value::Num(a)] => Ok(Value::Num(a.ceil())),
            _ => Err(EvalError("ceil(x) expects one number".into())),
        },
        "round" => match args {
            [Value::Num(a)] => Ok(Value::Num(a.round())),
            _ => Err(EvalError("round(x) expects one number".into())),
        },
        _ => Err(EvalError(format!("unknown function '{name}'"))),
    }
}
