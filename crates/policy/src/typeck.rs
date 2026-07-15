use std::collections::HashMap;

use crate::ast::{ActionSpec, BinaryOp, Channel, Expr, Ty, TypedAction, TypedPolicy, UnaryOp};
use crate::diag::{Diagnostic, Span};

#[derive(Debug, Clone)]
pub struct TypeContext {
    vars: HashMap<String, Ty>,
    person_fields: HashMap<String, Ty>,
}

impl Default for TypeContext {
    fn default() -> Self {
        let mut vars = HashMap::new();
        vars.insert("interested".to_string(), Ty::List);
        vars.insert("committed".to_string(), Ty::List);
        vars.insert("people".to_string(), Ty::List);
        vars.insert("hour".to_string(), Ty::Num);
        vars.insert("is_weekend".to_string(), Ty::Bool);
        vars.insert("min_people".to_string(), Ty::Num);
        vars.insert("max_people".to_string(), Ty::Num);
        vars.insert("duration".to_string(), Ty::Dur);
        vars.insert("max_commit".to_string(), Ty::Dur);

        let mut person_fields = HashMap::new();
        person_fields.insert("state".to_string(), Ty::State);
        person_fields.insert("eta".to_string(), Ty::Dur);
        person_fields.insert("arrived".to_string(), Ty::Bool);
        person_fields.insert("waited".to_string(), Ty::Dur);

        Self {
            vars,
            person_fields,
        }
    }
}

pub fn typecheck_policy(
    policy: crate::ast::Policy,
    ctx: &TypeContext,
) -> Result<TypedPolicy, Vec<Diagnostic>> {
    let mut errors = Vec::new();
    let cond_ty = type_of(&policy.condition, ctx, &mut errors);
    if cond_ty != Ty::Bool {
        errors.push(Diagnostic::new(
            Span::new(0, 0),
            "policy condition must evaluate to Bool",
        ));
    }

    match &policy.action {
        ActionSpec::Notify {
            after: Some(expr), ..
        } => {
            let ty = type_of(expr, ctx, &mut errors);
            if ty != Ty::Dur {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "notify(after: ...) expects a duration",
                ));
            }
        }
        ActionSpec::Notify { after: None, .. } => {}
    }

    if errors.is_empty() {
        Ok(TypedPolicy {
            condition: policy.condition,
            action: TypedAction {
                spec: policy.action,
                channel: Channel::Notify,
            },
        })
    } else {
        Err(errors)
    }
}

pub fn type_of(expr: &Expr, ctx: &TypeContext, errors: &mut Vec<Diagnostic>) -> Ty {
    match expr {
        Expr::Num(_) => Ty::Num,
        Expr::Bool(_) => Ty::Bool,
        Expr::DurationSecs(_) => Ty::Dur,
        Expr::Var(name) => ctx.vars.get(name).copied().unwrap_or_else(|| {
            errors.push(Diagnostic::new(
                Span::new(0, 0),
                format!("unknown variable '{name}'"),
            ));
            Ty::Num
        }),
        Expr::Count(name) => match ctx.vars.get(name).copied() {
            Some(Ty::List) => Ty::Num,
            Some(other) => {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    format!("'#{}' expects a list, got {:?}", name, other),
                ));
                Ty::Num
            }
            None => {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    format!("unknown list variable '{name}'"),
                ));
                Ty::Num
            }
        },
        Expr::Unary { op, expr } => {
            let t = type_of(expr, ctx, errors);
            match op {
                UnaryOp::Neg => {
                    if t == Ty::Num || t == Ty::Dur {
                        t
                    } else {
                        errors.push(Diagnostic::new(
                            Span::new(0, 0),
                            format!("unary '-' expects Num or Dur, got {:?}", t),
                        ));
                        Ty::Num
                    }
                }
                UnaryOp::Not => {
                    if t == Ty::Bool {
                        Ty::Bool
                    } else {
                        errors.push(Diagnostic::new(
                            Span::new(0, 0),
                            format!("'not' expects Bool, got {:?}", t),
                        ));
                        Ty::Bool
                    }
                }
            }
        }
        Expr::Binary { op, left, right } => {
            let l = type_of(left, ctx, errors);
            let r = type_of(right, ctx, errors);
            type_of_binary(*op, l, r, errors)
        }
        Expr::Call { name, args } => type_of_call(name, args, ctx, errors),
        Expr::Field { base, field } => {
            let t = type_of(base, ctx, errors);
            match t {
                Ty::Person => ctx.person_fields.get(field).copied().unwrap_or_else(|| {
                    errors.push(Diagnostic::new(
                        Span::new(0, 0),
                        format!("unknown person field '{field}'"),
                    ));
                    Ty::Num
                }),
                Ty::List => {
                    if ctx.person_fields.contains_key(field) {
                        Ty::List
                    } else {
                        errors.push(Diagnostic::new(
                            Span::new(0, 0),
                            format!("unknown person field '{field}'"),
                        ));
                        Ty::List
                    }
                }
                _ => {
                    errors.push(Diagnostic::new(
                        Span::new(0, 0),
                        format!("field access requires Person or List<Person>, got {:?}", t),
                    ));
                    Ty::Num
                }
            }
        }
    }
}

fn type_of_binary(op: BinaryOp, l: Ty, r: Ty, errors: &mut Vec<Diagnostic>) -> Ty {
    match op {
        BinaryOp::Add | BinaryOp::Sub => {
            if l == r && (l == Ty::Num || l == Ty::Dur) {
                l
            } else {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    format!("'{:?}' requires matching Num or Dur operands", op),
                ));
                Ty::Num
            }
        }
        BinaryOp::Mul => {
            if (l == Ty::Num && r == Ty::Num)
                || (l == Ty::Dur && r == Ty::Num)
                || (l == Ty::Num && r == Ty::Dur)
            {
                if l == Ty::Dur || r == Ty::Dur {
                    Ty::Dur
                } else {
                    Ty::Num
                }
            } else {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "'*' requires Num*Num, Dur*Num, or Num*Dur",
                ));
                Ty::Num
            }
        }
        BinaryOp::Div => {
            if l == Ty::Num && r == Ty::Num {
                Ty::Num
            } else if l == Ty::Dur && r == Ty::Num {
                Ty::Dur
            } else {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "'/' requires Num/Num or Dur/Num",
                ));
                Ty::Num
            }
        }
        BinaryOp::Mod => {
            if l == Ty::Num && r == Ty::Num {
                Ty::Num
            } else {
                errors.push(Diagnostic::new(Span::new(0, 0), "'%' requires Num%Num"));
                Ty::Num
            }
        }
        BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
            if l == r && (l == Ty::Num || l == Ty::Dur) {
                Ty::Bool
            } else {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "comparison requires matching Num or Dur operands",
                ));
                Ty::Bool
            }
        }
        BinaryOp::Eq | BinaryOp::Neq => {
            if l == r {
                Ty::Bool
            } else {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "equality requires matching operand types",
                ));
                Ty::Bool
            }
        }
        BinaryOp::And | BinaryOp::Or | BinaryOp::Xor => {
            if l == Ty::Bool && r == Ty::Bool {
                Ty::Bool
            } else {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "logical ops require Bool operands",
                ));
                Ty::Bool
            }
        }
    }
}

fn type_of_call(name: &str, args: &[Expr], ctx: &TypeContext, errors: &mut Vec<Diagnostic>) -> Ty {
    let arg_tys: Vec<Ty> = args.iter().map(|a| type_of(a, ctx, errors)).collect();
    match name {
        "len" => {
            if arg_tys.len() != 1 || arg_tys[0] != Ty::List {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    "len(list) expects one list argument",
                ));
            }
            Ty::Num
        }
        "sum" | "avg" => {
            if arg_tys.len() != 1 || arg_tys[0] != Ty::List {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    format!("{name}(...) expects one list argument"),
                ));
            }
            Ty::Num
        }
        "min" | "max" => {
            if arg_tys.len() != 2
                || arg_tys[0] != arg_tys[1]
                || (arg_tys[0] != Ty::Num && arg_tys[0] != Ty::Dur)
            {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    format!("{name}(a, b) expects two matching Num or Dur arguments"),
                ));
                Ty::Num
            } else {
                arg_tys[0]
            }
        }
        "abs" | "floor" | "ceil" | "round" => {
            if arg_tys.len() != 1 || arg_tys[0] != Ty::Num {
                errors.push(Diagnostic::new(
                    Span::new(0, 0),
                    format!("{name}(x) expects one Num argument"),
                ));
            }
            Ty::Num
        }
        other => {
            errors.push(Diagnostic::new(
                Span::new(0, 0),
                format!("unknown function '{other}'"),
            ));
            Ty::Num
        }
    }
}
