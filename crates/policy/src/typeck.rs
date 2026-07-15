use std::collections::HashMap;

use crate::ast::{
    ActionSpec, BinaryOp, Binding, Channel, Decl, Expr, MatchArm, Pattern, Program, Ty,
    TypedAction, TypedProgram, UnaryOp,
};
use crate::diag::{Diagnostic, Span};

/// Registry of user-declared nominal types (records + enums), built from a
/// program's `type` declarations. OCaml-style: fields and variants are resolved
/// by name, so record literals and field access don't need explicit annotation.
#[derive(Debug, Clone, Default)]
pub struct TypeRegistry {
    records: HashMap<String, Vec<(String, Ty)>>,
    field_owner: HashMap<String, String>,
    variant_enum: HashMap<String, String>,
    enums: HashMap<String, Vec<String>>,
}

impl TypeRegistry {
    pub fn from_decls(decls: &[Decl]) -> (Self, Vec<Diagnostic>) {
        let mut reg = TypeRegistry::default();
        let mut errors = Vec::new();
        for decl in decls {
            match decl {
                Decl::Record { name, fields } => {
                    if reg.records.contains_key(name) || reg.enums.contains_key(name) {
                        errors.push(Diagnostic::new(Span::new(0, 0), format!("duplicate type '{name}'")));
                    }
                    for (field, _) in fields {
                        reg.field_owner.insert(field.clone(), name.clone());
                    }
                    reg.records.insert(name.clone(), fields.clone());
                }
                Decl::Enum { name, variants } => {
                    if reg.records.contains_key(name) || reg.enums.contains_key(name) {
                        errors.push(Diagnostic::new(Span::new(0, 0), format!("duplicate type '{name}'")));
                    }
                    for v in variants {
                        reg.variant_enum.insert(v.clone(), name.clone());
                    }
                    reg.enums.insert(name.clone(), variants.clone());
                }
            }
        }
        (reg, errors)
    }
}

/// The room variables available to every policy. Lists carry element types
/// (ML-style parametric `List<T>`): names are `Str`, timed entries are
/// `(Str, Dur)` tuples.
#[derive(Debug, Clone)]
pub struct TypeContext {
    vars: HashMap<String, Ty>,
}

impl Default for TypeContext {
    fn default() -> Self {
        let mut vars = HashMap::new();
        vars.insert("interested".to_string(), Ty::list(Ty::Str));
        vars.insert("lurkers".to_string(), Ty::list(Ty::Str));
        vars.insert("people".to_string(), Ty::list(Ty::Str));
        vars.insert(
            "committed".to_string(),
            Ty::list(Ty::Tuple(vec![Ty::Str, Ty::Dur])),
        );
        vars.insert(
            "arrived".to_string(),
            Ty::list(Ty::Tuple(vec![Ty::Str, Ty::Dur])),
        );
        vars.insert("hour".to_string(), Ty::Num);
        vars.insert("is_weekend".to_string(), Ty::Bool);
        vars.insert("min_people".to_string(), Ty::Num);
        vars.insert("max_people".to_string(), Ty::Num);
        vars.insert("duration".to_string(), Ty::Dur);
        vars.insert("max_commit".to_string(), Ty::Dur);
        Self { vars }
    }
}

pub fn typecheck_program(
    program: Program,
    ctx: &TypeContext,
) -> Result<TypedProgram, Vec<Diagnostic>> {
    let (reg, mut decl_errors) = TypeRegistry::from_decls(&program.decls);
    let mut inf = Infer::new(&reg);
    inf.errors.append(&mut decl_errors);
    let mut env = ctx.vars.clone();

    for binding in &program.bindings {
        match binding {
            Binding::Simple { name, value } => {
                let ty = inf.infer(value, &env);
                env.insert(name.clone(), ty);
            }
            Binding::Record {
                fields,
                ignore_rest,
                value,
            } => {
                let vty = inf.infer(value, &env);
                inf.bind_record_fields(&vty, fields, *ignore_rest, &mut env);
            }
        }
    }

    let cond_ty = inf.infer(&program.rule.condition, &env);
    inf.expect(&cond_ty, &Ty::Bool, "policy condition must evaluate to Bool");

    if let ActionSpec::Notify {
        after: Some(expr), ..
    } = &program.rule.action
    {
        let ty = inf.infer(expr, &env);
        inf.expect(&ty, &Ty::Dur, "notify(after: ...) expects a duration");
    }

    if inf.errors.is_empty() {
        let channel = match program.rule.action {
            ActionSpec::Notify { .. } => Channel::Notify,
            ActionSpec::Commit | ActionSpec::Interest | ActionSpec::Lurk => Channel::Node,
        };
        Ok(TypedProgram {
            decls: program.decls,
            bindings: program.bindings,
            condition: program.rule.condition,
            action: TypedAction {
                spec: program.rule.action,
                channel,
            },
        })
    } else {
        Err(inf.errors)
    }
}

/// Type-check a standalone expression (terminal/REPL). Returns its type.
pub fn typecheck_expr(expr: &Expr, ctx: &TypeContext) -> Result<Ty, Vec<Diagnostic>> {
    let reg = TypeRegistry::default();
    let mut inf = Infer::new(&reg);
    let ty = inf.infer(expr, &ctx.vars);
    if inf.errors.is_empty() {
        Ok(inf.zonk(&ty))
    } else {
        Err(inf.errors)
    }
}

pub fn ty_to_string(ty: &Ty) -> String {
    show(ty)
}

struct Scheme {
    quantified: Vec<u32>,
    ty: Ty,
}

struct Infer<'a> {
    subst: HashMap<u32, Ty>,
    next: u32,
    errors: Vec<Diagnostic>,
    reg: &'a TypeRegistry,
}

impl<'a> Infer<'a> {
    fn new(reg: &'a TypeRegistry) -> Self {
        Self {
            subst: HashMap::new(),
            next: 0,
            errors: Vec::new(),
            reg,
        }
    }

    fn fresh(&mut self) -> Ty {
        let id = self.next;
        self.next += 1;
        Ty::Var(id)
    }

    fn error(&mut self, msg: impl Into<String>) {
        self.errors.push(Diagnostic::new(Span::new(0, 0), msg));
    }

    /// Follow substitutions to the representative type (shallow at the head).
    fn resolve(&self, ty: &Ty) -> Ty {
        match ty {
            Ty::Var(id) => match self.subst.get(id) {
                Some(inner) => self.resolve(inner),
                None => ty.clone(),
            },
            _ => ty.clone(),
        }
    }

    /// Deeply apply the substitution (for display of the final type).
    fn zonk(&self, ty: &Ty) -> Ty {
        match self.resolve(ty) {
            Ty::List(inner) => Ty::List(Box::new(self.zonk(&inner))),
            Ty::Tuple(items) => Ty::Tuple(items.iter().map(|t| self.zonk(t)).collect()),
            Ty::Fun(a, b) => Ty::Fun(Box::new(self.zonk(&a)), Box::new(self.zonk(&b))),
            other => other,
        }
    }

    fn occurs(&self, id: u32, ty: &Ty) -> bool {
        match self.resolve(ty) {
            Ty::Var(other) => other == id,
            Ty::List(inner) => self.occurs(id, &inner),
            Ty::Tuple(items) => items.iter().any(|t| self.occurs(id, t)),
            Ty::Fun(a, b) => self.occurs(id, &a) || self.occurs(id, &b),
            _ => false,
        }
    }

    fn unify(&mut self, a: &Ty, b: &Ty) -> Result<(), String> {
        let a = self.resolve(a);
        let b = self.resolve(b);
        match (a, b) {
            (Ty::Var(x), Ty::Var(y)) if x == y => Ok(()),
            (Ty::Var(x), other) | (other, Ty::Var(x)) => {
                if self.occurs(x, &other) {
                    return Err("recursive type".to_string());
                }
                self.subst.insert(x, other);
                Ok(())
            }
            (Ty::Num, Ty::Num)
            | (Ty::Bool, Ty::Bool)
            | (Ty::Dur, Ty::Dur)
            | (Ty::Str, Ty::Str)
            | (Ty::Unit, Ty::Unit) => Ok(()),
            (Ty::Named(x), Ty::Named(y)) if x == y => Ok(()),
            (Ty::List(x), Ty::List(y)) => self.unify(&x, &y),
            (Ty::Tuple(xs), Ty::Tuple(ys)) => {
                if xs.len() != ys.len() {
                    return Err(format!(
                        "tuple arity mismatch: {} vs {}",
                        xs.len(),
                        ys.len()
                    ));
                }
                for (x, y) in xs.iter().zip(ys.iter()) {
                    self.unify(x, y)?;
                }
                Ok(())
            }
            (Ty::Fun(a1, b1), Ty::Fun(a2, b2)) => {
                self.unify(&a1, &a2)?;
                self.unify(&b1, &b2)
            }
            (x, y) => Err(format!("cannot unify {} with {}", show(&x), show(&y))),
        }
    }

    fn expect(&mut self, ty: &Ty, expected: &Ty, msg: &str) {
        if let Err(detail) = self.unify(ty, expected) {
            self.error(format!("{msg} ({detail})"));
        }
    }

    fn instantiate(&mut self, scheme: &Scheme) -> Ty {
        let mapping: HashMap<u32, Ty> =
            scheme.quantified.iter().map(|q| (*q, self.fresh())).collect();
        subst_vars(&scheme.ty, &mapping)
    }

    fn infer(&mut self, expr: &Expr, env: &HashMap<String, Ty>) -> Ty {
        match expr {
            Expr::Num(_) => Ty::Num,
            Expr::Bool(_) => Ty::Bool,
            Expr::Str(_) => Ty::Str,
            Expr::DurationSecs(_) => Ty::Dur,
            Expr::Var(name) => {
                if let Some(t) = env.get(name) {
                    t.clone()
                } else if let Some(enum_name) = self.reg.variant_enum.get(name) {
                    Ty::Named(enum_name.clone())
                } else if let Some(scheme) = builtin_scheme(name) {
                    self.instantiate(&scheme)
                } else if is_adhoc_builtin(name) {
                    self.error(format!("builtin '{name}' must be applied to arguments"));
                    self.fresh()
                } else {
                    self.error(format!("unknown variable '{name}'"));
                    self.fresh()
                }
            }
            Expr::Count(name) => {
                let elem = self.fresh();
                let list = Ty::list(elem);
                match env.get(name) {
                    Some(t) => {
                        let t = t.clone();
                        self.expect(&t, &list, &format!("'#{name}' expects a list"));
                    }
                    None => self.error(format!("unknown list variable '{name}'")),
                }
                Ty::Num
            }
            Expr::Tuple(items) => {
                Ty::Tuple(items.iter().map(|e| self.infer(e, env)).collect())
            }
            Expr::Unary { op, expr } => {
                let t = self.infer(expr, env);
                match op {
                    UnaryOp::Neg => self.expect_numeric(&t, "unary '-' expects Num or Dur"),
                    UnaryOp::Not => {
                        self.expect(&t, &Ty::Bool, "'not' expects Bool");
                        Ty::Bool
                    }
                }
            }
            Expr::Binary { op, left, right } => {
                let l = self.infer(left, env);
                let r = self.infer(right, env);
                self.infer_binary(*op, l, r)
            }
            Expr::Apply { func, arg } => self.infer_apply(func, arg, env),
            Expr::Lambda { param, body } => {
                let pv = self.fresh();
                let mut inner = env.clone();
                inner.insert(param.clone(), pv.clone());
                let bt = self.infer(body, &inner);
                Ty::func(pv, bt)
            }
            Expr::Match { scrutinee, arms } => self.infer_match(scrutinee, arms, env),
            Expr::TupleIndex { base, index } => {
                let bt = self.infer(base, env);
                match self.resolve(&bt) {
                    Ty::Tuple(items) => match items.get(*index) {
                        Some(t) => t.clone(),
                        None => {
                            self.error(format!(
                                "tuple index {index} out of range (len {})",
                                items.len()
                            ));
                            self.fresh()
                        }
                    },
                    other => {
                        self.error(format!(
                            "tuple index requires a tuple of known arity, got {}",
                            show(&other)
                        ));
                        self.fresh()
                    }
                }
            }
            Expr::Record { fields } => self.infer_record(fields, env),
            Expr::Field { base, field } => {
                let owner = match self.reg.field_owner.get(field) {
                    Some(o) => o.clone(),
                    None => {
                        self.error(format!("unknown record field '{field}'"));
                        return self.fresh();
                    }
                };
                let bt = self.infer(base, env);
                self.expect(&bt, &Ty::Named(owner.clone()), "field access on wrong record type");
                self.record_field_ty(&owner, field)
            }
        }
    }

    fn record_field_ty(&mut self, record: &str, field: &str) -> Ty {
        match self.reg.records.get(record) {
            Some(fields) => match fields.iter().find(|(f, _)| f == field) {
                Some((_, ty)) => ty.clone(),
                None => {
                    self.error(format!("record '{record}' has no field '{field}'"));
                    self.fresh()
                }
            },
            None => {
                self.error(format!("unknown record type '{record}'"));
                self.fresh()
            }
        }
    }

    fn infer_record(&mut self, fields: &[(String, Expr)], env: &HashMap<String, Ty>) -> Ty {
        // Resolve the nominal record type from the set of field names (OCaml
        // resolves record literals by their labels).
        let mut names: Vec<String> = fields.iter().map(|(f, _)| f.clone()).collect();
        names.sort();
        let mut matched: Option<String> = None;
        for (rname, rfields) in &self.reg.records {
            let mut rnames: Vec<String> = rfields.iter().map(|(f, _)| f.clone()).collect();
            rnames.sort();
            if rnames == names {
                matched = Some(rname.clone());
                break;
            }
        }
        let rname = match matched {
            Some(r) => r,
            None => {
                self.error("record literal does not match any declared record type");
                for (_, e) in fields {
                    let _ = self.infer(e, env);
                }
                return self.fresh();
            }
        };
        for (fname, fexpr) in fields {
            let ft = self.infer(fexpr, env);
            let expected = self.record_field_ty(&rname, fname);
            self.expect(&ft, &expected, &format!("record field '{fname}' has wrong type"));
        }
        Ty::Named(rname)
    }

    fn bind_record_fields(
        &mut self,
        value_ty: &Ty,
        fields: &[String],
        ignore_rest: bool,
        env: &mut HashMap<String, Ty>,
    ) {
        let resolved = self.resolve(value_ty);
        let rname = match resolved {
            Ty::Named(n) if self.reg.records.contains_key(&n) => n,
            other => {
                self.error(format!(
                    "destructuring requires a record value, got {}",
                    show(&other)
                ));
                for f in fields {
                    let fresh = self.fresh();
                    env.insert(f.clone(), fresh);
                }
                return;
            }
        };
        let declared: Vec<String> = self
            .reg
            .records
            .get(&rname)
            .map(|fs| fs.iter().map(|(f, _)| f.clone()).collect())
            .unwrap_or_default();
        if !ignore_rest && fields.len() != declared.len() {
            self.error(format!(
                "record pattern must bind all fields of '{rname}' (or use '_')"
            ));
        }
        for f in fields {
            if !declared.contains(f) {
                self.error(format!("record '{rname}' has no field '{f}'"));
            }
            let ty = self.record_field_ty(&rname, f);
            env.insert(f.clone(), ty);
        }
    }

    fn infer_apply(&mut self, func: &Expr, arg: &Expr, env: &HashMap<String, Ty>) -> Ty {
        // Overloaded builtins are checked in call position (they are not
        // first-class values because their types can't be expressed as a
        // single scheme).
        if let Expr::Var(name) = func {
            if !env.contains_key(name) && is_adhoc_builtin(name) {
                let arg_ty = self.infer(arg, env);
                return self.check_adhoc_builtin(name, &arg_ty);
            }
        }
        let ft = self.infer(func, env);
        let at = self.infer(arg, env);
        let ret = self.fresh();
        let expected = Ty::func(at, ret.clone());
        if let Err(detail) = self.unify(&ft, &expected) {
            self.error(format!("cannot apply value as a function ({detail})"));
        }
        ret
    }

    fn infer_match(
        &mut self,
        scrutinee: &Expr,
        arms: &[MatchArm],
        env: &HashMap<String, Ty>,
    ) -> Ty {
        let st = self.infer(scrutinee, env);
        if arms.is_empty() {
            self.error("match must have at least one arm");
            return self.fresh();
        }
        let result = self.fresh();
        let mut has_wildcard = false;
        let mut saw_true = false;
        let mut saw_false = false;
        let mut covered_variants: Vec<String> = Vec::new();
        for arm in arms {
            match &arm.pattern {
                Pattern::Wildcard => has_wildcard = true,
                Pattern::Num(_) => self.expect(&st, &Ty::Num, "match pattern type mismatch"),
                Pattern::Str(_) => self.expect(&st, &Ty::Str, "match pattern type mismatch"),
                Pattern::Dur(_) => self.expect(&st, &Ty::Dur, "match pattern type mismatch"),
                Pattern::Bool(b) => {
                    self.expect(&st, &Ty::Bool, "match pattern type mismatch");
                    if *b {
                        saw_true = true;
                    } else {
                        saw_false = true;
                    }
                }
                Pattern::Variant(v) => match self.reg.variant_enum.get(v) {
                    Some(enum_name) => {
                        let en = enum_name.clone();
                        self.expect(&st, &Ty::Named(en), "match pattern type mismatch");
                        covered_variants.push(v.clone());
                    }
                    None => self.error(format!("unknown variant '{v}' in match pattern")),
                },
            }
            let bt = self.infer(&arm.body, env);
            if let Err(detail) = self.unify(&result, &bt) {
                self.error(format!("match arms must have the same type ({detail})"));
            }
        }
        let bool_exhaustive = matches!(self.resolve(&st), Ty::Bool) && saw_true && saw_false;
        let enum_exhaustive = match self.resolve(&st) {
            Ty::Named(name) => self
                .reg
                .enums
                .get(&name)
                .map(|vs| vs.iter().all(|v| covered_variants.contains(v)))
                .unwrap_or(false),
            _ => false,
        };
        if !has_wildcard && !bool_exhaustive && !enum_exhaustive {
            self.error("match must be exhaustive: cover all cases or add a '_' arm");
        }
        result
    }

    fn infer_binary(&mut self, op: BinaryOp, l: Ty, r: Ty) -> Ty {
        match op {
            BinaryOp::Add | BinaryOp::Sub => {
                if let Err(detail) = self.unify(&l, &r) {
                    self.error(format!("'{op:?}' requires matching operands ({detail})"));
                }
                self.expect_numeric(&l, "'+'/'-' expects Num or Dur")
            }
            BinaryOp::Mul => {
                let lr = self.resolve(&l);
                let rr = self.resolve(&r);
                match (lr, rr) {
                    (Ty::Dur, _) => {
                        self.expect(&r, &Ty::Num, "Dur * Num expected");
                        Ty::Dur
                    }
                    (_, Ty::Dur) => {
                        self.expect(&l, &Ty::Num, "Num * Dur expected");
                        Ty::Dur
                    }
                    _ => {
                        self.expect(&l, &Ty::Num, "'*' expects Num");
                        self.expect(&r, &Ty::Num, "'*' expects Num");
                        Ty::Num
                    }
                }
            }
            BinaryOp::Div => {
                let lr = self.resolve(&l);
                if matches!(lr, Ty::Dur) {
                    self.expect(&r, &Ty::Num, "Dur / Num expected");
                    Ty::Dur
                } else {
                    self.expect(&l, &Ty::Num, "'/' expects Num");
                    self.expect(&r, &Ty::Num, "'/' expects Num");
                    Ty::Num
                }
            }
            BinaryOp::Mod => {
                self.expect(&l, &Ty::Num, "'%' expects Num");
                self.expect(&r, &Ty::Num, "'%' expects Num");
                Ty::Num
            }
            BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
                if let Err(detail) = self.unify(&l, &r) {
                    self.error(format!("comparison requires matching operands ({detail})"));
                }
                let _ = self.expect_numeric(&l, "comparison expects Num or Dur");
                Ty::Bool
            }
            BinaryOp::Eq | BinaryOp::Neq => {
                if let Err(detail) = self.unify(&l, &r) {
                    self.error(format!("equality requires matching operands ({detail})"));
                }
                Ty::Bool
            }
            BinaryOp::And | BinaryOp::Or | BinaryOp::Xor => {
                self.expect(&l, &Ty::Bool, "logical ops require Bool");
                self.expect(&r, &Ty::Bool, "logical ops require Bool");
                Ty::Bool
            }
        }
    }

    /// Require Num or Dur; if still an unbound var, default to Num.
    fn expect_numeric(&mut self, ty: &Ty, msg: &str) -> Ty {
        match self.resolve(ty) {
            Ty::Num => Ty::Num,
            Ty::Dur => Ty::Dur,
            Ty::Var(_) => {
                let _ = self.unify(ty, &Ty::Num);
                Ty::Num
            }
            other => {
                self.error(format!("{msg} (got {})", show(&other)));
                Ty::Num
            }
        }
    }

    fn check_adhoc_builtin(&mut self, name: &str, arg: &Ty) -> Ty {
        match name {
            "sum" | "avg" => {
                let elem = self.fresh();
                if self.unify(arg, &Ty::list(elem.clone())).is_err() {
                    self.error(format!("{name}(list) expects a list"));
                    return Ty::Num;
                }
                match self.resolve(&elem) {
                    Ty::Dur => Ty::Dur,
                    Ty::Var(_) => {
                        let _ = self.unify(&elem, &Ty::Num);
                        Ty::Num
                    }
                    Ty::Num => Ty::Num,
                    other => {
                        self.error(format!("{name}(list) expects List<Num> or List<Dur>, got List<{}>", show(&other)));
                        Ty::Num
                    }
                }
            }
            "min" | "max" => {
                let t = self.fresh();
                if self
                    .unify(arg, &Ty::Tuple(vec![t.clone(), t.clone()]))
                    .is_err()
                {
                    self.error(format!("{name}(a, b) expects two matching arguments"));
                    return Ty::Num;
                }
                self.expect_numeric(&t, &format!("{name}(a, b) expects Num or Dur"))
            }
            "abs" | "floor" | "ceil" | "round" => {
                self.expect(arg, &Ty::Num, &format!("{name}(x) expects Num"));
                Ty::Num
            }
            other => {
                self.error(format!("unknown builtin '{other}'"));
                Ty::Num
            }
        }
    }
}

fn subst_vars(ty: &Ty, mapping: &HashMap<u32, Ty>) -> Ty {
    match ty {
        Ty::Var(id) => mapping.get(id).cloned().unwrap_or_else(|| ty.clone()),
        Ty::List(inner) => Ty::List(Box::new(subst_vars(inner, mapping))),
        Ty::Tuple(items) => Ty::Tuple(items.iter().map(|t| subst_vars(t, mapping)).collect()),
        Ty::Fun(a, b) => Ty::Fun(
            Box::new(subst_vars(a, mapping)),
            Box::new(subst_vars(b, mapping)),
        ),
        other => other.clone(),
    }
}

fn is_adhoc_builtin(name: &str) -> bool {
    matches!(
        name,
        "sum" | "avg" | "min" | "max" | "abs" | "floor" | "ceil" | "round"
    )
}

/// Polymorphic builtins usable as first-class values (fresh instantiation per
/// use — Damas–Milner let-polymorphism, scoped to the standard library).
fn builtin_scheme(name: &str) -> Option<Scheme> {
    match name {
        "len" => Some(Scheme {
            quantified: vec![0],
            ty: Ty::func(Ty::list(Ty::Var(0)), Ty::Num),
        }),
        "map" => Some(Scheme {
            quantified: vec![0, 1],
            ty: Ty::func(
                Ty::Tuple(vec![
                    Ty::func(Ty::Var(0), Ty::Var(1)),
                    Ty::list(Ty::Var(0)),
                ]),
                Ty::list(Ty::Var(1)),
            ),
        }),
        "filter" => Some(Scheme {
            quantified: vec![0],
            ty: Ty::func(
                Ty::Tuple(vec![
                    Ty::func(Ty::Var(0), Ty::Bool),
                    Ty::list(Ty::Var(0)),
                ]),
                Ty::list(Ty::Var(0)),
            ),
        }),
        "any" | "all" => Some(Scheme {
            quantified: vec![0],
            ty: Ty::func(
                Ty::Tuple(vec![
                    Ty::func(Ty::Var(0), Ty::Bool),
                    Ty::list(Ty::Var(0)),
                ]),
                Ty::Bool,
            ),
        }),
        "proj" => Some(Scheme {
            quantified: vec![0, 1],
            ty: Ty::func(
                Ty::list(Ty::Tuple(vec![Ty::Var(0), Ty::Var(1)])),
                Ty::Tuple(vec![Ty::list(Ty::Var(0)), Ty::list(Ty::Var(1))]),
            ),
        }),
        _ => None,
    }
}

fn show(ty: &Ty) -> String {
    match ty {
        Ty::Num => "Num".to_string(),
        Ty::Bool => "Bool".to_string(),
        Ty::Dur => "Dur".to_string(),
        Ty::Str => "Str".to_string(),
        Ty::Unit => "Unit".to_string(),
        Ty::List(inner) => format!("List<{}>", show(inner)),
        Ty::Tuple(items) => {
            let inner: Vec<String> = items.iter().map(show).collect();
            format!("({})", inner.join(", "))
        }
        Ty::Fun(a, b) => format!("{} -> {}", show(a), show(b)),
        Ty::Var(id) => format!("t{id}"),
        Ty::Named(name) => name.clone(),
    }
}
