//! Tree-walking evaluator. Produces a structured **effect program** (see
//! [`Effect`]) that the host executes against the simulation. Trait methods are
//! resolved by runtime dispatch on the type tag of the first argument
//! (built-in `Eq`/`Ord`/`Display`/`Arith` are handled structurally; user
//! `impl`s dispatch to their bindings). A step limit bounds recursion so the
//! self-hosted prelude cannot hang the playground.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::ast::{
    BinaryOp, Binding, Decl, Expr, MatchArm, Pattern, StrSeg, TypeBody, TypedProgram, UnaryOp,
};
use crate::prelude::PRELUDE_SRC;

const STEP_LIMIT: u64 = 200_000;

/// A runtime value. Data variants are (de)serialisable so the host can pass
/// globals in and read results out. Closures/methods are runtime-only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum Value {
    Num(f64),
    Bool(bool),
    Dur(i64),
    Str(String),
    List(Vec<Value>),
    Tuple(Vec<Value>),
    Record {
        #[serde(rename = "type")]
        type_name: String,
        fields: BTreeMap<String, Value>,
    },
    Variant {
        #[serde(rename = "type")]
        type_name: String,
        name: String,
        values: Vec<Value>,
    },
    Action(Effect),
    #[serde(skip)]
    Closure(Rc<Closure>),
    #[serde(skip)]
    Ctor {
        type_name: String,
        name: String,
        arity: usize,
        args: Vec<Value>,
    },
    #[serde(skip)]
    Builtin {
        name: String,
        arity: usize,
        args: Vec<Value>,
    },
    #[serde(skip)]
    Method {
        name: String,
        trait_name: String,
        arity: usize,
        args: Vec<Value>,
    },
    #[serde(skip)]
    #[default]
    Unit,
}

#[derive(Debug, Clone)]
pub struct Closure {
    pub param: String,
    pub body: Expr,
    pub env: HashMap<String, Value>,
    pub rec_name: Option<String>,
}

/// The structured effect program produced by evaluating a policy action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum Effect {
    #[serde(rename = "notify")]
    Notify { message: String },
    #[serde(rename = "state")]
    SetState {
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eta_delta_secs: Option<i64>,
    },
    #[serde(rename = "sleep")]
    Sleep { secs: i64 },
    #[serde(rename = "seq")]
    Seq { steps: Vec<Effect> },
    #[serde(rename = "noop")]
    Noop,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvalError(pub String);

/// The evaluation environment supplied by the host: global variable values.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EvalEnv {
    #[serde(default)]
    pub vars: HashMap<String, Value>,
}

struct Evaluator {
    steps: u64,
    ctors: HashMap<String, (String, usize)>, // ctor name -> (enum type, arity)
    enum_order: HashMap<String, Vec<String>>, // enum type -> variant names in order
    record_fields: HashMap<String, Vec<String>>, // record type -> field names
    field_owner: HashMap<String, Vec<String>>,
    impls: HashMap<(String, String), HashMap<String, Value>>, // (trait, type head) -> methods
}

impl Evaluator {
    fn new() -> Self {
        Evaluator {
            steps: 0,
            ctors: HashMap::new(),
            enum_order: HashMap::new(),
            record_fields: HashMap::new(),
            field_owner: HashMap::new(),
            impls: HashMap::new(),
        }
    }

    fn tick(&mut self) -> Result<(), EvalError> {
        self.steps += 1;
        if self.steps > STEP_LIMIT {
            Err(EvalError("evaluation step limit exceeded".to_string()))
        } else {
            Ok(())
        }
    }

    fn register_builtin_types(&mut self) {
        for decl in crate::types::builtin_type_decls() {
            self.register_type(&decl);
        }
    }

    fn register_type(&mut self, decl: &crate::ast::TypeDecl) {
        match &decl.body {
            TypeBody::Variant(variants) => {
                let names: Vec<String> = variants.iter().map(|v| v.name.clone()).collect();
                self.enum_order.insert(decl.name.clone(), names);
                for v in variants {
                    self.ctors
                        .insert(v.name.clone(), (decl.name.clone(), v.args.len()));
                }
            }
            TypeBody::Record(fields) => {
                let names: Vec<String> = fields.iter().map(|(n, _)| n.clone()).collect();
                for n in &names {
                    self.field_owner
                        .entry(n.clone())
                        .or_default()
                        .push(decl.name.clone());
                }
                self.record_fields.insert(decl.name.clone(), names);
            }
            TypeBody::Alias(_) => {}
        }
    }

    fn register_decl(&mut self, decl: &Decl, env: &HashMap<String, Value>) {
        match decl {
            Decl::Type(t) => self.register_type(t),
            Decl::Impl(i) => {
                if let Some(head) = crate::types::ty_head(&i.ty) {
                    let mut methods = HashMap::new();
                    for b in &i.methods {
                        if let Pattern::Var(name) = &b.pattern {
                            if let Ok(v) = self.make_binding_value(name, &b.value, env) {
                                methods.insert(name.clone(), v);
                            }
                        }
                    }
                    self.impls.insert((i.trait_name.clone(), head), methods);
                }
            }
            Decl::Trait(_) => {}
        }
    }

    fn make_binding_value(
        &mut self,
        name: &str,
        value: &Expr,
        env: &HashMap<String, Value>,
    ) -> Result<Value, EvalError> {
        if let Expr::Lambda { param, body } = value {
            Ok(Value::Closure(Rc::new(Closure {
                param: param.clone(),
                body: (**body).clone(),
                env: env.clone(),
                rec_name: Some(name.to_string()),
            })))
        } else {
            self.eval(value, env)
        }
    }

    fn eval_bindings(
        &mut self,
        bindings: &[Binding],
        mut env: HashMap<String, Value>,
    ) -> Result<HashMap<String, Value>, EvalError> {
        for b in bindings {
            match &b.pattern {
                Pattern::Var(name) => {
                    let v = self.make_binding_value(name, &b.value, &env)?;
                    env.insert(name.clone(), v);
                }
                pat => {
                    let v = self.eval(&b.value, &env)?;
                    let mut binds = HashMap::new();
                    if !self.match_pattern(pat, &v, &mut binds) {
                        return Err(EvalError("binding pattern did not match".to_string()));
                    }
                    env.extend(binds);
                }
            }
        }
        Ok(env)
    }

    fn eval(&mut self, expr: &Expr, env: &HashMap<String, Value>) -> Result<Value, EvalError> {
        self.tick()?;
        match expr {
            Expr::Num(n) => Ok(Value::Num(*n)),
            Expr::Bool(b) => Ok(Value::Bool(*b)),
            Expr::DurationSecs(s) => Ok(Value::Dur(*s)),
            Expr::Str(segs) => {
                let mut out = String::new();
                for seg in segs {
                    match seg {
                        StrSeg::Lit(s) => out.push_str(s),
                        StrSeg::Expr(e) => {
                            let v = self.eval(e, env)?;
                            out.push_str(&self.display(&v));
                        }
                    }
                }
                Ok(Value::Str(out))
            }
            Expr::Var(name) => env
                .get(name)
                .cloned()
                .ok_or_else(|| EvalError(format!("unbound variable '{name}'"))),
            Expr::Ctor(name) => {
                let (type_name, arity) = self
                    .ctors
                    .get(name)
                    .cloned()
                    .ok_or_else(|| EvalError(format!("unknown constructor '{name}'")))?;
                if arity == 0 {
                    Ok(Value::Variant {
                        type_name,
                        name: name.clone(),
                        values: vec![],
                    })
                } else {
                    Ok(Value::Ctor {
                        type_name,
                        name: name.clone(),
                        arity,
                        args: vec![],
                    })
                }
            }
            Expr::List(items) => {
                let mut out = Vec::with_capacity(items.len());
                for it in items {
                    out.push(self.eval(it, env)?);
                }
                Ok(Value::List(out))
            }
            Expr::Tuple(items) => {
                let mut out = Vec::with_capacity(items.len());
                for it in items {
                    out.push(self.eval(it, env)?);
                }
                Ok(Value::Tuple(out))
            }
            Expr::Cons(head, tail) => {
                let h = self.eval(head, env)?;
                let t = self.eval(tail, env)?;
                match t {
                    Value::List(mut xs) => {
                        xs.insert(0, h);
                        Ok(Value::List(xs))
                    }
                    _ => Err(EvalError("'::' expects a list on the right".to_string())),
                }
            }
            Expr::Record(fields) => {
                let mut map = BTreeMap::new();
                for (name, e) in fields {
                    map.insert(name.clone(), self.eval(e, env)?);
                }
                let labels: Vec<String> = fields.iter().map(|(n, _)| n.clone()).collect();
                let type_name = self.record_type_for(&labels);
                Ok(Value::Record {
                    type_name,
                    fields: map,
                })
            }
            Expr::Field { base, field } => {
                let b = self.eval(base, env)?;
                match b {
                    Value::Record { fields, .. } => fields
                        .get(field)
                        .cloned()
                        .ok_or_else(|| EvalError(format!("no field '{field}'"))),
                    _ => Err(EvalError(format!("cannot read field '{field}'"))),
                }
            }
            Expr::TupleIndex { base, index } => {
                let b = self.eval(base, env)?;
                match b {
                    Value::Tuple(items) if *index < items.len() => Ok(items[*index].clone()),
                    _ => Err(EvalError(format!("cannot take .{index}"))),
                }
            }
            Expr::Index { base, index } => {
                let b = self.eval(base, env)?;
                let i = self.eval(index, env)?;
                let idx = as_num(&i)?;
                if idx.fract() != 0.0 || idx < 0.0 {
                    return Err(EvalError(
                        "list index must be a non-negative integer".to_string(),
                    ));
                }
                let idx = idx as usize;
                match b {
                    Value::List(items) if idx < items.len() => Ok(items[idx].clone()),
                    Value::List(_) => Err(EvalError(format!("list index out of bounds: {idx}"))),
                    _ => Err(EvalError("indexing requires a list".to_string())),
                }
            }
            Expr::Lambda { param, body } => Ok(Value::Closure(Rc::new(Closure {
                param: param.clone(),
                body: (**body).clone(),
                env: env.clone(),
                rec_name: None,
            }))),
            Expr::Apply { func, arg } => {
                let f = self.eval(func, env)?;
                let a = self.eval(arg, env)?;
                self.apply(f, a)
            }
            Expr::If { cond, then, els } => {
                let c = self.eval(cond, env)?;
                match c {
                    Value::Bool(true) => self.eval(then, env),
                    Value::Bool(false) => self.eval(els, env),
                    _ => Err(EvalError("if condition must be Bool".to_string())),
                }
            }
            Expr::Match { scrutinee, arms } => self.eval_match(scrutinee, arms, env),
            Expr::Block(items) => {
                let mut effects = Vec::new();
                for it in items {
                    let v = self.eval(it, env)?;
                    effects.push(self.as_effect(v)?);
                }
                Ok(Value::Action(flatten_seq(effects)))
            }
            Expr::Unary { op, expr } => {
                let v = self.eval(expr, env)?;
                match (op, v) {
                    (UnaryOp::Not, Value::Bool(b)) => Ok(Value::Bool(!b)),
                    (UnaryOp::Neg, Value::Num(n)) => Ok(Value::Num(-n)),
                    (UnaryOp::Neg, Value::Dur(d)) => Ok(Value::Dur(-d)),
                    _ => Err(EvalError("bad operand for unary operator".to_string())),
                }
            }
            Expr::Binary { op, left, right } => {
                if matches!(op, BinaryOp::Add | BinaryOp::Sub)
                    && matches!(left.as_ref(), Expr::Var(name) if name == "commit")
                {
                    let delta = match self.eval(right, env)? {
                        Value::Dur(secs) => secs,
                        _ => {
                            return Err(EvalError("commit ETA adjustment must be Dur".to_string()))
                        }
                    };
                    return Ok(Value::Action(Effect::SetState {
                        state: "committed".to_string(),
                        eta_delta_secs: Some(if matches!(op, BinaryOp::Sub) {
                            -delta
                        } else {
                            delta
                        }),
                    }));
                }
                if matches!(op, BinaryOp::And | BinaryOp::Or) {
                    // Short-circuit.
                    let l = self.eval(left, env)?;
                    let lb = as_bool(&l)?;
                    return match op {
                        BinaryOp::And if !lb => Ok(Value::Bool(false)),
                        BinaryOp::Or if lb => Ok(Value::Bool(true)),
                        _ => {
                            let r = self.eval(right, env)?;
                            Ok(Value::Bool(as_bool(&r)?))
                        }
                    };
                }
                let l = self.eval(left, env)?;
                let r = self.eval(right, env)?;
                self.binary(*op, l, r)
            }
        }
    }

    fn apply(&mut self, func: Value, arg: Value) -> Result<Value, EvalError> {
        match func {
            Value::Closure(clo) => {
                let mut call_env = clo.env.clone();
                if let Some(name) = &clo.rec_name {
                    call_env.insert(name.clone(), Value::Closure(clo.clone()));
                }
                call_env.insert(clo.param.clone(), arg);
                self.eval(&clo.body, &call_env)
            }
            Value::Ctor {
                type_name,
                name,
                arity,
                mut args,
            } => {
                args.push(arg);
                if args.len() == arity {
                    Ok(Value::Variant {
                        type_name,
                        name,
                        values: args,
                    })
                } else {
                    Ok(Value::Ctor {
                        type_name,
                        name,
                        arity,
                        args,
                    })
                }
            }
            Value::Builtin {
                name,
                arity,
                mut args,
            } => {
                args.push(arg);
                if args.len() == arity {
                    self.run_builtin(&name, args)
                } else {
                    Ok(Value::Builtin { name, arity, args })
                }
            }
            Value::Method {
                name,
                trait_name,
                arity,
                mut args,
            } => {
                args.push(arg);
                if args.len() == arity {
                    self.run_method(&trait_name, &name, args)
                } else {
                    Ok(Value::Method {
                        name,
                        trait_name,
                        arity,
                        args,
                    })
                }
            }
            _ => Err(EvalError("cannot call a non-function value".to_string())),
        }
    }

    fn eval_match(
        &mut self,
        scrutinee: &Expr,
        arms: &[MatchArm],
        env: &HashMap<String, Value>,
    ) -> Result<Value, EvalError> {
        let v = self.eval(scrutinee, env)?;
        for arm in arms {
            let mut binds = HashMap::new();
            if self.match_pattern(&arm.pattern, &v, &mut binds) {
                let mut inner = env.clone();
                inner.extend(binds);
                return self.eval(&arm.body, &inner);
            }
        }
        Err(EvalError("no match arm matched".to_string()))
    }

    fn match_pattern(
        &self,
        pat: &Pattern,
        value: &Value,
        binds: &mut HashMap<String, Value>,
    ) -> bool {
        match pat {
            Pattern::Wildcard => true,
            Pattern::Var(name) => {
                binds.insert(name.clone(), value.clone());
                true
            }
            Pattern::Num(n) => matches!(value, Value::Num(v) if v == n),
            Pattern::Bool(b) => matches!(value, Value::Bool(v) if v == b),
            Pattern::Str(s) => matches!(value, Value::Str(v) if v == s),
            Pattern::Dur(d) => matches!(value, Value::Dur(v) if v == d),
            Pattern::Tuple(ps) => match value {
                Value::Tuple(vs) if vs.len() == ps.len() => ps
                    .iter()
                    .zip(vs.iter())
                    .all(|(p, v)| self.match_pattern(p, v, binds)),
                _ => false,
            },
            Pattern::Nil => matches!(value, Value::List(v) if v.is_empty()),
            Pattern::Cons(head, tail) => match value {
                Value::List(vs) if !vs.is_empty() => {
                    let h = &vs[0];
                    let rest = Value::List(vs[1..].to_vec());
                    self.match_pattern(head, h, binds) && self.match_pattern(tail, &rest, binds)
                }
                _ => false,
            },
            Pattern::List(ps) => match value {
                Value::List(vs) if vs.len() == ps.len() => ps
                    .iter()
                    .zip(vs.iter())
                    .all(|(p, v)| self.match_pattern(p, v, binds)),
                _ => false,
            },
            Pattern::Variant { name, args } => match value {
                Value::Variant {
                    name: vn, values, ..
                } if vn == name && values.len() == args.len() => args
                    .iter()
                    .zip(values.iter())
                    .all(|(p, v)| self.match_pattern(p, v, binds)),
                _ => false,
            },
            Pattern::Record { fields, .. } => match value {
                Value::Record { fields: vf, .. } => fields.iter().all(|(name, sub)| {
                    if let Some(v) = vf.get(name) {
                        match sub {
                            Some(p) => self.match_pattern(p, v, binds),
                            None => {
                                binds.insert(name.clone(), v.clone());
                                true
                            }
                        }
                    } else {
                        false
                    }
                }),
                _ => false,
            },
        }
    }

    fn record_type_for(&self, labels: &[String]) -> String {
        use std::collections::HashSet;
        let set: HashSet<&str> = labels.iter().map(|s| s.as_str()).collect();
        for (rname, fields) in &self.record_fields {
            let rset: HashSet<&str> = fields.iter().map(|s| s.as_str()).collect();
            if rset == set {
                return rname.clone();
            }
        }
        "Record".to_string()
    }

    // ----- operators -----

    fn binary(&mut self, op: BinaryOp, l: Value, r: Value) -> Result<Value, EvalError> {
        match op {
            BinaryOp::Xor => Ok(Value::Bool(as_bool(&l)? ^ as_bool(&r)?)),
            BinaryOp::And | BinaryOp::Or => unreachable!("handled by short-circuit"),
            BinaryOp::Eq => Ok(Value::Bool(values_equal(&l, &r))),
            BinaryOp::Neq => Ok(Value::Bool(!values_equal(&l, &r))),
            BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
                let ord = self.compare(&l, &r)?;
                let res = match op {
                    BinaryOp::Lt => ord == std::cmp::Ordering::Less,
                    BinaryOp::Lte => ord != std::cmp::Ordering::Greater,
                    BinaryOp::Gt => ord == std::cmp::Ordering::Greater,
                    BinaryOp::Gte => ord != std::cmp::Ordering::Less,
                    _ => unreachable!(),
                };
                Ok(Value::Bool(res))
            }
            BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
                self.arith(op, l, r)
            }
        }
    }

    fn arith(&self, op: BinaryOp, l: Value, r: Value) -> Result<Value, EvalError> {
        use Value::{Dur, Num};
        match (op, &l, &r) {
            (BinaryOp::Add, Num(a), Num(b)) => Ok(Num(a + b)),
            (BinaryOp::Sub, Num(a), Num(b)) => Ok(Num(a - b)),
            (BinaryOp::Mul, Num(a), Num(b)) => Ok(Num(a * b)),
            (BinaryOp::Div, Num(a), Num(b)) => Ok(Num(a / b)),
            (BinaryOp::Mod, Num(a), Num(b)) => Ok(Num(a % b)),
            (BinaryOp::Add, Dur(a), Dur(b)) => Ok(Dur(a + b)),
            (BinaryOp::Sub, Dur(a), Dur(b)) => Ok(Dur(a - b)),
            (BinaryOp::Mul, Dur(a), Num(b)) => Ok(Dur(((*a as f64) * b) as i64)),
            (BinaryOp::Mul, Num(a), Dur(b)) => Ok(Dur(((*b as f64) * a) as i64)),
            (BinaryOp::Div, Dur(a), Num(b)) => Ok(Dur(((*a as f64) / b) as i64)),
            (BinaryOp::Div, Dur(a), Dur(b)) => {
                if *b == 0 {
                    Err(EvalError("division by zero".to_string()))
                } else {
                    Ok(Num(*a as f64 / *b as f64))
                }
            }
            _ => Err(EvalError("bad operands for arithmetic".to_string())),
        }
    }

    fn compare(&self, l: &Value, r: &Value) -> Result<std::cmp::Ordering, EvalError> {
        use std::cmp::Ordering;
        match (l, r) {
            (Value::Num(a), Value::Num(b)) => a
                .partial_cmp(b)
                .ok_or_else(|| EvalError("NaN comparison".to_string())),
            (Value::Dur(a), Value::Dur(b)) => Ok(a.cmp(b)),
            (Value::Str(a), Value::Str(b)) => Ok(a.cmp(b)),
            (Value::Bool(a), Value::Bool(b)) => Ok(a.cmp(b)),
            (Value::List(a), Value::List(b)) => {
                for (x, y) in a.iter().zip(b.iter()) {
                    let c = self.compare(x, y)?;
                    if c != Ordering::Equal {
                        return Ok(c);
                    }
                }
                Ok(a.len().cmp(&b.len()))
            }
            (Value::Tuple(a), Value::Tuple(b)) => {
                for (x, y) in a.iter().zip(b.iter()) {
                    let c = self.compare(x, y)?;
                    if c != Ordering::Equal {
                        return Ok(c);
                    }
                }
                Ok(Ordering::Equal)
            }
            (Value::Record { type_name, fields }, Value::Record { fields: fb, .. }) => {
                let order = self.record_fields.get(type_name);
                let keys: Vec<&String> = match order {
                    Some(ks) => ks.iter().collect(),
                    None => fields.keys().collect(),
                };
                for k in keys {
                    if let (Some(x), Some(y)) = (fields.get(k), fb.get(k)) {
                        let c = self.compare(x, y)?;
                        if c != Ordering::Equal {
                            return Ok(c);
                        }
                    }
                }
                Ok(Ordering::Equal)
            }
            (
                Value::Variant {
                    type_name,
                    name: na,
                    values: va,
                },
                Value::Variant {
                    name: nb,
                    values: vb,
                    ..
                },
            ) => {
                let ia = self.variant_index(type_name, na);
                let ib = self.variant_index(type_name, nb);
                let c = ia.cmp(&ib);
                if c != Ordering::Equal {
                    return Ok(c);
                }
                for (x, y) in va.iter().zip(vb.iter()) {
                    let c = self.compare(x, y)?;
                    if c != Ordering::Equal {
                        return Ok(c);
                    }
                }
                Ok(Ordering::Equal)
            }
            _ => Err(EvalError("values are not comparable".to_string())),
        }
    }

    fn variant_index(&self, type_name: &str, name: &str) -> usize {
        self.enum_order
            .get(type_name)
            .and_then(|v| v.iter().position(|n| n == name))
            .unwrap_or(0)
    }

    // ----- builtins & methods -----

    fn run_builtin(&mut self, name: &str, args: Vec<Value>) -> Result<Value, EvalError> {
        match name {
            "abs" => Ok(Value::Num(as_num(&args[0])?.abs())),
            "floor" => Ok(Value::Num(as_num(&args[0])?.floor())),
            "ceil" => Ok(Value::Num(as_num(&args[0])?.ceil())),
            "round" => Ok(Value::Num(as_num(&args[0])?.round())),
            "min" | "max" => {
                let xs = as_list(&args[0])?;
                if xs.is_empty() {
                    return Err(EvalError(format!("{name} of empty list")));
                }
                let want_less = name == "min";
                let mut best = xs[0].clone();
                for v in &xs[1..] {
                    let c = self.compare(v, &best)?;
                    if (want_less && c == std::cmp::Ordering::Less)
                        || (!want_less && c == std::cmp::Ordering::Greater)
                    {
                        best = v.clone();
                    }
                }
                Ok(best)
            }
            "notify" => Ok(Value::Action(Effect::Notify {
                message: as_str(&args[0])?,
            })),
            "sleep" => Ok(Value::Action(Effect::Sleep {
                secs: as_dur(&args[0])?,
            })),
            "delay" => {
                let inner = self.as_effect(args[0].clone())?;
                let secs = as_dur(&args[1])?;
                Ok(Value::Action(flatten_seq(vec![
                    Effect::Sleep { secs },
                    inner,
                ])))
            }
            _ => Err(EvalError(format!("unknown builtin '{name}'"))),
        }
    }

    fn run_method(
        &mut self,
        trait_name: &str,
        method: &str,
        args: Vec<Value>,
    ) -> Result<Value, EvalError> {
        // Built-in traits are handled structurally.
        match (trait_name, method) {
            ("Display", "show") => return Ok(Value::Str(self.display(&args[0]))),
            ("Eq", "eq") => return Ok(Value::Bool(values_equal(&args[0], &args[1]))),
            ("Ord", m) => {
                let ord = self.compare(&args[0], &args[1])?;
                let res = match m {
                    "lt" => ord == std::cmp::Ordering::Less,
                    "le" => ord != std::cmp::Ordering::Greater,
                    "gt" => ord == std::cmp::Ordering::Greater,
                    "ge" => ord != std::cmp::Ordering::Less,
                    _ => return Err(EvalError(format!("unknown Ord method '{m}'"))),
                };
                return Ok(Value::Bool(res));
            }
            ("Arith", m) => {
                let op = match m {
                    "add" => BinaryOp::Add,
                    "sub" => BinaryOp::Sub,
                    "mul" => BinaryOp::Mul,
                    "div" => BinaryOp::Div,
                    "rem" => BinaryOp::Mod,
                    _ => return Err(EvalError(format!("unknown Arith method '{m}'"))),
                };
                return self.arith(op, args[0].clone(), args[1].clone());
            }
            _ => {}
        }
        // User-defined trait: dispatch on the first argument's type tag.
        let tag = type_tag(&args[0]);
        let key = (trait_name.to_string(), tag.clone());
        let method_val = self
            .impls
            .get(&key)
            .and_then(|m| m.get(method))
            .cloned()
            .ok_or_else(|| {
                EvalError(format!(
                    "no impl of {trait_name} for {tag} (method '{method}')"
                ))
            })?;
        let mut cur = method_val;
        for a in args {
            cur = self.apply(cur, a)?;
        }
        Ok(cur)
    }

    fn as_effect(&self, v: Value) -> Result<Effect, EvalError> {
        match v {
            Value::Action(e) => Ok(e),
            _ => Err(EvalError("expected an action".to_string())),
        }
    }

    // ----- display -----

    fn display(&self, v: &Value) -> String {
        match v {
            Value::Str(s) => s.clone(),
            other => self.format(other),
        }
    }

    fn format(&self, v: &Value) -> String {
        match v {
            Value::Num(n) => format_num(*n),
            Value::Bool(b) => b.to_string(),
            Value::Dur(s) => format_dur(*s),
            Value::Str(s) => format!("\"{s}\""),
            Value::List(items) => {
                let parts: Vec<String> = items.iter().map(|x| self.format(x)).collect();
                format!("[{}]", parts.join(", "))
            }
            Value::Tuple(items) => {
                let parts: Vec<String> = items.iter().map(|x| self.format(x)).collect();
                format!("({})", parts.join(", "))
            }
            Value::Record { fields, .. } => {
                let parts: Vec<String> = fields
                    .iter()
                    .map(|(k, v)| format!("{k} = {}", self.format(v)))
                    .collect();
                format!("{{ {} }}", parts.join(", "))
            }
            Value::Variant { name, values, .. } => {
                if values.is_empty() {
                    name.clone()
                } else {
                    let parts: Vec<String> = values.iter().map(|x| self.format(x)).collect();
                    format!("{name}({})", parts.join(", "))
                }
            }
            Value::Action(_) => "<action>".to_string(),
            Value::Closure(_)
            | Value::Builtin { .. }
            | Value::Method { .. }
            | Value::Ctor { .. } => "<function>".to_string(),
            Value::Unit => "()".to_string(),
        }
    }
}

fn flatten_seq(effects: Vec<Effect>) -> Effect {
    let mut steps = Vec::new();
    for e in effects {
        match e {
            Effect::Seq { steps: inner } => steps.extend(inner),
            Effect::Noop => {}
            other => steps.push(other),
        }
    }
    match steps.len() {
        0 => Effect::Noop,
        1 => steps.pop().unwrap(),
        _ => Effect::Seq { steps },
    }
}

fn type_tag(v: &Value) -> String {
    match v {
        Value::Num(_) => "Num".to_string(),
        Value::Bool(_) => "Bool".to_string(),
        Value::Dur(_) => "Dur".to_string(),
        Value::Str(_) => "Str".to_string(),
        Value::List(_) => "List".to_string(),
        Value::Tuple(_) => "Tuple".to_string(),
        Value::Record { type_name, .. } => type_name.clone(),
        Value::Variant { type_name, .. } => type_name.clone(),
        Value::Action(_) => "Action".to_string(),
        _ => "Fun".to_string(),
    }
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Dur(x), Value::Dur(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::List(x), Value::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| values_equal(a, b))
        }
        (Value::Tuple(x), Value::Tuple(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| values_equal(a, b))
        }
        (Value::Record { fields: x, .. }, Value::Record { fields: y, .. }) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).map(|w| values_equal(v, w)).unwrap_or(false))
        }
        (
            Value::Variant {
                name: na,
                values: va,
                ..
            },
            Value::Variant {
                name: nb,
                values: vb,
                ..
            },
        ) => na == nb && va.len() == vb.len() && va.iter().zip(vb).all(|(a, b)| values_equal(a, b)),
        _ => false,
    }
}

fn as_bool(v: &Value) -> Result<bool, EvalError> {
    match v {
        Value::Bool(b) => Ok(*b),
        _ => Err(EvalError("expected Bool".to_string())),
    }
}
fn as_num(v: &Value) -> Result<f64, EvalError> {
    match v {
        Value::Num(n) => Ok(*n),
        _ => Err(EvalError("expected Num".to_string())),
    }
}
fn as_dur(v: &Value) -> Result<i64, EvalError> {
    match v {
        Value::Dur(d) => Ok(*d),
        _ => Err(EvalError("expected Dur".to_string())),
    }
}
fn as_str(v: &Value) -> Result<String, EvalError> {
    match v {
        Value::Str(s) => Ok(s.clone()),
        _ => Err(EvalError("expected Str".to_string())),
    }
}
fn as_list(v: &Value) -> Result<Vec<Value>, EvalError> {
    match v {
        Value::List(xs) => Ok(xs.clone()),
        _ => Err(EvalError("expected a list".to_string())),
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
    let mut s = total.abs();
    let h = s / 3600;
    s %= 3600;
    let m = s / 60;
    let sec = s % 60;
    let mut out = String::new();
    if h > 0 {
        out.push_str(&format!("{h}h"));
    }
    if m > 0 {
        out.push_str(&format!("{m}m"));
    }
    if sec > 0 {
        out.push_str(&format!("{sec}s"));
    }
    if neg {
        format!("-{out}")
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Runtime environment construction
// ---------------------------------------------------------------------------

fn base_runtime(eval: &mut Evaluator) -> HashMap<String, Value> {
    let mut env: HashMap<String, Value> = HashMap::new();
    let builtin = |name: &str, arity: usize| Value::Builtin {
        name: name.to_string(),
        arity,
        args: vec![],
    };
    for f in ["abs", "floor", "ceil", "round", "min", "max"] {
        env.insert(f.to_string(), builtin(f, 1));
    }
    env.insert("notify".to_string(), builtin("notify", 1));
    env.insert("sleep".to_string(), builtin("sleep", 1));
    env.insert("delay".to_string(), builtin("delay", 2));
    env.insert(
        "commit".to_string(),
        Value::Action(Effect::SetState {
            state: "committed".to_string(),
            eta_delta_secs: None,
        }),
    );
    env.insert(
        "interest".to_string(),
        Value::Action(Effect::SetState {
            state: "interested".to_string(),
            eta_delta_secs: None,
        }),
    );
    env.insert(
        "lurk".to_string(),
        Value::Action(Effect::SetState {
            state: "lurker".to_string(),
            eta_delta_secs: None,
        }),
    );
    // Trait methods (built-in traits) as dispatchable method values.
    for t in crate::types::builtin_traits() {
        for (mname, mty) in &t.methods {
            env.insert(
                mname.clone(),
                Value::Method {
                    name: mname.clone(),
                    trait_name: t.name.clone(),
                    arity: arrow_arity(mty),
                    args: vec![],
                },
            );
        }
    }
    // Prelude closures.
    let src = format!("{PRELUDE_SRC}\ntrue => lurk\n");
    if let Ok(program) = crate::parse::parse_program(&src) {
        for decl in &program.decls {
            eval.register_decl(decl, &env);
        }
        if let Ok(new_env) = eval.eval_bindings(&program.bindings, env.clone()) {
            env = new_env;
        }
    }
    env
}

fn arrow_arity(ty: &crate::ast::Ty) -> usize {
    let mut n = 0;
    let mut cur = ty;
    while let crate::ast::Ty::Fun(_, b) = cur {
        n += 1;
        cur = b;
    }
    n
}

/// Evaluate a typed policy against host-provided globals, producing the effect
/// program to run when the condition holds (or `None` when it does not).
pub fn eval_program(program: &TypedProgram, env: &EvalEnv) -> Result<Option<Effect>, EvalError> {
    let mut eval = Evaluator::new();
    eval.register_builtin_types();
    let mut runtime = base_runtime(&mut eval);
    for (k, v) in &env.vars {
        runtime.insert(k.clone(), v.clone());
    }
    // User-declared trait methods become dispatchable method values.
    for decl in &program.decls {
        if let Decl::Trait(t) = decl {
            for (mname, mty) in &t.methods {
                runtime.insert(
                    mname.clone(),
                    Value::Method {
                        name: mname.clone(),
                        trait_name: t.name.clone(),
                        arity: arrow_arity(mty),
                        args: vec![],
                    },
                );
            }
        }
    }
    for decl in &program.decls {
        eval.register_decl(decl, &runtime);
    }
    runtime = eval.eval_bindings(&program.bindings, runtime)?;
    let action = eval.eval(&program.action, &runtime)?;
    let effect = eval.as_effect(action)?;
    // A no-op effect means the policy chose to do nothing this round.
    if matches!(effect, Effect::Noop) {
        Ok(None)
    } else {
        Ok(Some(effect))
    }
}

/// Evaluate a standalone expression (terminal/REPL) with host globals.
pub fn eval_expr(expr: &Expr, env: &EvalEnv) -> Result<Value, EvalError> {
    let mut eval = Evaluator::new();
    eval.register_builtin_types();
    let mut runtime = base_runtime(&mut eval);
    for (k, v) in &env.vars {
        runtime.insert(k.clone(), v.clone());
    }
    eval.eval(expr, &runtime)
}

/// Render a value for REPL/terminal output (strings are quoted).
pub fn format_value(v: &Value) -> String {
    let eval = Evaluator::new();
    eval.format(v)
}
