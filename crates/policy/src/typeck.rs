//! Hindley–Milner type inference (Algorithm W) with let-generalisation, plus a
//! pragmatic type-class ("trait") constraint solver. Class constraints are
//! collected during inference and discharged against built-in impls
//! (`Eq`/`Ord`/`Display`/`Arith`) and user `impl`s; unresolved-but-concrete or
//! ambiguous constraints are type errors. Runtime dispatch (see `eval.rs`)
//! resolves the actual method by the type tag of the first argument.

use std::collections::{HashMap, HashSet};

use crate::ast::{
    BinaryOp, Binding, Decl, Expr, ImplDecl, MatchArm, Pattern, Program, StrSeg, TraitDecl, Ty,
    TypeBody, TypeDecl, TypedProgram, UnaryOp, VariantDef,
};
use crate::diag::{Diagnostic, Span};
use crate::prelude::PRELUDE_SRC;
use crate::types::{
    builtin_impl_holds, builtin_traits, builtin_type_decls, global_types, ty_head, Constraint,
    Scheme, TraitInfo,
};

#[derive(Debug, Clone)]
struct RecordDef {
    params: Vec<String>,
    fields: Vec<(String, Ty)>,
}

#[derive(Debug, Clone)]
struct CtorInfo {
    scheme: Scheme,
    arity: usize,
}

/// The ambient typing context: built-in types, traits, globals, kernel
/// primitives, and the checked prelude. User declarations extend a clone.
#[derive(Debug, Clone)]
pub struct TypeContext {
    records: HashMap<String, RecordDef>,
    field_owner: HashMap<String, Vec<String>>,
    ctors: HashMap<String, CtorInfo>,
    enums: HashMap<String, Vec<String>>,
    traits: Vec<TraitInfo>,
    user_impls: HashSet<(String, String)>,
    env: HashMap<String, Scheme>,
}

impl Default for TypeContext {
    fn default() -> Self {
        let mut ctx = TypeContext::base();
        ctx.load_prelude();
        ctx
    }
}

impl TypeContext {
    fn base() -> TypeContext {
        let mut ctx = TypeContext {
            records: HashMap::new(),
            field_owner: HashMap::new(),
            ctors: HashMap::new(),
            enums: HashMap::new(),
            traits: builtin_traits(),
            user_impls: HashSet::new(),
            env: HashMap::new(),
        };
        for decl in builtin_type_decls() {
            ctx.register_type_decl(&decl);
        }
        // Trait methods become polymorphic, constrained schemes in the env.
        let traits = ctx.traits.clone();
        for t in &traits {
            for (mname, mty) in &t.methods {
                let scheme = method_scheme(t, mty);
                ctx.env.insert(mname.clone(), scheme);
            }
        }
        for (name, ty) in global_types() {
            ctx.env.insert(name, Scheme::mono(ty));
        }
        ctx.install_kernel();
        ctx
    }

    fn install_kernel(&mut self) {
        let mut add = |name: &str, scheme: Scheme| {
            self.env.insert(name.to_string(), scheme);
        };
        let num = Ty::num;
        // Numeric intrinsics.
        for f in ["abs", "floor", "ceil", "round"] {
            add(f, Scheme::mono(Ty::func(num(), num())));
        }
        // min/max : forall a. Ord a => [a] -> a
        for f in ["min", "max"] {
            add(
                f,
                Scheme {
                    vars: vec![0],
                    constraints: vec![Constraint {
                        trait_name: "Ord".to_string(),
                        ty: Ty::Var(0),
                    }],
                    ty: Ty::func(Ty::list(Ty::Var(0)), Ty::Var(0)),
                },
            );
        }
        // Effects.
        add("notify", Scheme::mono(Ty::func(Ty::str(), Ty::action())));
        add("sleep", Scheme::mono(Ty::func(Ty::dur(), Ty::action())));
        add(
            "delay",
            Scheme::mono(Ty::arrow(&[Ty::action(), Ty::dur()], Ty::action())),
        );
        for a in ["commit", "interest", "lurk"] {
            add(a, Scheme::mono(Ty::action()));
        }
    }

    fn load_prelude(&mut self) {
        let src = format!("{PRELUDE_SRC}\ntrue => lurk\n");
        let program = match crate::parse::parse_program(&src) {
            Ok(p) => p,
            Err(diags) => {
                panic!("prelude failed to parse: {:?}", diags.first());
            }
        };
        for decl in &program.decls {
            self.register_decl(decl);
        }
        let mut infer = Infer::new(self);
        let env = self.env.clone();
        let new_env = match infer.check_bindings(&program.bindings, env) {
            Ok(env) => env,
            Err(_) => panic!("prelude failed to type-check: {:?}", infer.errors.first()),
        };
        self.env = new_env;
    }

    fn register_decl(&mut self, decl: &Decl) {
        match decl {
            Decl::Type(t) => self.register_type_decl(t),
            Decl::Trait(t) => self.register_trait_decl(t),
            Decl::Impl(i) => self.register_impl_decl(i),
        }
    }

    fn register_type_decl(&mut self, decl: &TypeDecl) {
        match &decl.body {
            TypeBody::Record(fields) => {
                self.records.insert(
                    decl.name.clone(),
                    RecordDef {
                        params: decl.params.clone(),
                        fields: fields.clone(),
                    },
                );
                for (f, _) in fields {
                    self.field_owner
                        .entry(f.clone())
                        .or_default()
                        .push(decl.name.clone());
                }
            }
            TypeBody::Variant(variants) => {
                let ctor_names: Vec<String> = variants.iter().map(|v| v.name.clone()).collect();
                self.enums.insert(decl.name.clone(), ctor_names);
                for v in variants {
                    let scheme = variant_scheme(decl, v);
                    self.ctors.insert(
                        v.name.clone(),
                        CtorInfo {
                            scheme,
                            arity: v.args.len(),
                        },
                    );
                }
            }
            TypeBody::Alias(_) => {}
        }
    }

    fn register_trait_decl(&mut self, decl: &TraitDecl) {
        let info = TraitInfo {
            name: decl.name.clone(),
            param: decl.param.clone(),
            methods: decl.methods.clone(),
            superclasses: vec![],
            builtin: false,
            doc: decl.doc.clone(),
        };
        for (mname, mty) in &info.methods {
            let scheme = method_scheme(&info, mty);
            self.env.insert(mname.clone(), scheme);
        }
        self.traits.push(info);
    }

    fn register_impl_decl(&mut self, decl: &ImplDecl) {
        if let Some(head) = ty_head(&decl.ty) {
            self.user_impls.insert((decl.trait_name.clone(), head));
        }
    }

    pub fn trait_infos(&self) -> &[TraitInfo] {
        &self.traits
    }

    /// Rendered type scheme for a name in the environment (for docs/help).
    pub fn describe(&self, name: &str) -> Option<String> {
        self.env.get(name).map(scheme_to_string)
    }
}

/// Build the constrained scheme for a trait method: `forall p. Trait p => ty`,
/// with the trait's named parameter turned into a bound type variable.
fn method_scheme(t: &TraitInfo, mty: &Ty) -> Scheme {
    let pid = 0u32; // local scheme var id
    let ty = replace_named_var(mty, &t.param, pid);
    Scheme {
        vars: vec![pid],
        constraints: vec![Constraint {
            trait_name: t.name.clone(),
            ty: Ty::Var(pid),
        }],
        ty,
    }
}

/// Build the scheme for a variant constructor, e.g. `Some : forall a. a -> Option<a>`.
fn variant_scheme(decl: &TypeDecl, v: &VariantDef) -> Scheme {
    // Assign each type parameter a scheme var id by position.
    let mut param_ids: HashMap<String, u32> = HashMap::new();
    for (i, p) in decl.params.iter().enumerate() {
        param_ids.insert(p.clone(), i as u32);
    }
    let result = Ty::Con(
        decl.name.clone(),
        decl.params.iter().map(|p| Ty::Var(param_ids[p])).collect(),
    );
    let args: Vec<Ty> = v
        .args
        .iter()
        .map(|a| replace_named_vars(a, &param_ids))
        .collect();
    let ty = Ty::arrow(&args, result);
    Scheme {
        vars: param_ids.values().copied().collect(),
        constraints: vec![],
        ty,
    }
}

/// Replace a single lowercase named type variable (`Con(name, [])`) with `Var(id)`.
fn replace_named_var(ty: &Ty, name: &str, id: u32) -> Ty {
    let mut map = HashMap::new();
    map.insert(name.to_string(), id);
    replace_named_vars(ty, &map)
}

fn replace_named_vars(ty: &Ty, map: &HashMap<String, u32>) -> Ty {
    match ty {
        Ty::Con(name, args) if args.is_empty() && map.contains_key(name) => Ty::Var(map[name]),
        Ty::Con(name, args) => Ty::Con(
            name.clone(),
            args.iter().map(|a| replace_named_vars(a, map)).collect(),
        ),
        Ty::Tuple(items) => Ty::Tuple(items.iter().map(|a| replace_named_vars(a, map)).collect()),
        Ty::Fun(a, b) => Ty::func(replace_named_vars(a, map), replace_named_vars(b, map)),
        Ty::Var(v) => Ty::Var(*v),
    }
}

// ---------------------------------------------------------------------------
// Inference engine
// ---------------------------------------------------------------------------

struct Infer<'a> {
    ctx: &'a TypeContext,
    subst: HashMap<u32, Ty>,
    counter: u32,
    constraints: Vec<Constraint>,
    errors: Vec<Diagnostic>,
}

impl<'a> Infer<'a> {
    fn new(ctx: &'a TypeContext) -> Self {
        Infer {
            ctx,
            subst: HashMap::new(),
            counter: 1000,
            constraints: Vec::new(),
            errors: Vec::new(),
        }
    }

    fn fresh(&mut self) -> Ty {
        let id = self.counter;
        self.counter += 1;
        Ty::Var(id)
    }

    fn error(&mut self, msg: impl Into<String>) {
        self.errors
            .push(Diagnostic::new(Span::new(0, 0), msg.into()));
    }

    // ----- substitution -----

    fn resolve(&self, ty: &Ty) -> Ty {
        let mut cur = ty.clone();
        while let Ty::Var(id) = cur {
            match self.subst.get(&id) {
                Some(t) => cur = t.clone(),
                None => break,
            }
        }
        cur
    }

    fn apply(&self, ty: &Ty) -> Ty {
        match self.resolve(ty) {
            Ty::Con(name, args) => Ty::Con(name, args.iter().map(|a| self.apply(a)).collect()),
            Ty::Tuple(items) => Ty::Tuple(items.iter().map(|a| self.apply(a)).collect()),
            Ty::Fun(a, b) => Ty::func(self.apply(&a), self.apply(&b)),
            Ty::Var(v) => Ty::Var(v),
        }
    }

    fn occurs(&self, id: u32, ty: &Ty) -> bool {
        match self.resolve(ty) {
            Ty::Var(v) => v == id,
            Ty::Con(_, args) => args.iter().any(|a| self.occurs(id, a)),
            Ty::Tuple(items) => items.iter().any(|a| self.occurs(id, a)),
            Ty::Fun(a, b) => self.occurs(id, &a) || self.occurs(id, &b),
        }
    }

    fn unify(&mut self, a: &Ty, b: &Ty) -> Result<(), String> {
        let ra = self.resolve(a);
        let rb = self.resolve(b);
        match (ra, rb) {
            (Ty::Var(x), Ty::Var(y)) if x == y => Ok(()),
            (Ty::Var(x), other) | (other, Ty::Var(x)) => {
                if self.occurs(x, &other) {
                    return Err("cannot construct infinite type".to_string());
                }
                self.subst.insert(x, other);
                Ok(())
            }
            (Ty::Con(n1, a1), Ty::Con(n2, a2)) => {
                if n1 != n2 || a1.len() != a2.len() {
                    return Err(format!(
                        "type mismatch: {} vs {}",
                        show_ty(&Ty::Con(n1, a1)),
                        show_ty(&Ty::Con(n2, a2))
                    ));
                }
                for (x, y) in a1.iter().zip(a2.iter()) {
                    self.unify(x, y)?;
                }
                Ok(())
            }
            (Ty::Tuple(x), Ty::Tuple(y)) => {
                if x.len() != y.len() {
                    return Err("tuple size mismatch".to_string());
                }
                for (a, b) in x.iter().zip(y.iter()) {
                    self.unify(a, b)?;
                }
                Ok(())
            }
            (Ty::Fun(a1, b1), Ty::Fun(a2, b2)) => {
                self.unify(&a1, &a2)?;
                self.unify(&b1, &b2)
            }
            (x, y) => Err(format!("type mismatch: {} vs {}", show_ty(&x), show_ty(&y))),
        }
    }

    fn unify_at(&mut self, a: &Ty, b: &Ty, what: &str) {
        if let Err(e) = self.unify(a, b) {
            self.error(format!("{what}: {e}"));
        }
    }

    fn instantiate(&mut self, scheme: &Scheme) -> Ty {
        let mut map: HashMap<u32, Ty> = HashMap::new();
        for v in &scheme.vars {
            let f = self.fresh();
            map.insert(*v, f);
        }
        for c in &scheme.constraints {
            let ty = subst_ids(&c.ty, &map);
            self.constraints.push(Constraint {
                trait_name: c.trait_name.clone(),
                ty,
            });
        }
        subst_ids(&scheme.ty, &map)
    }

    // ----- bindings -----

    fn check_bindings(
        &mut self,
        bindings: &[Binding],
        mut env: HashMap<String, Scheme>,
    ) -> Result<HashMap<String, Scheme>, ()> {
        for b in bindings {
            match &b.pattern {
                Pattern::Var(name) => {
                    // Allow self-recursion: pre-bind a fresh monotype.
                    let placeholder = self.fresh();
                    let mut rec_env = env.clone();
                    rec_env.insert(name.clone(), Scheme::mono(placeholder.clone()));
                    let ty = self.infer(&b.value, &rec_env);
                    self.unify_at(&placeholder, &ty, &format!("binding '{name}'"));
                    self.solve_constraints();
                    let scheme = self.generalize(&ty, &env);
                    env.insert(name.clone(), scheme);
                }
                other => {
                    let ty = self.infer(&b.value, &env);
                    let binds = self.check_pattern(other, &ty);
                    self.solve_constraints();
                    for (name, bty) in binds {
                        let scheme = self.generalize(&bty, &env);
                        env.insert(name, scheme);
                    }
                }
            }
        }
        if self.errors.is_empty() {
            Ok(env)
        } else {
            Err(())
        }
    }

    fn generalize(&mut self, ty: &Ty, env: &HashMap<String, Scheme>) -> Scheme {
        let applied = self.apply(ty);
        let mut env_vars: HashSet<u32> = HashSet::new();
        for s in env.values() {
            let ty = self.apply(&s.ty);
            collect_vars(&ty, &mut env_vars);
        }
        let mut vars_in_ty: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        collect_vars_ordered(&applied, &mut vars_in_ty, &mut seen);
        let gen_vars: Vec<u32> = vars_in_ty
            .into_iter()
            .filter(|v| !env_vars.contains(v))
            .collect();
        let gen_set: HashSet<u32> = gen_vars.iter().copied().collect();
        // Keep any still-pending constraints that mention generalised vars.
        let mut constraints = Vec::new();
        let pending = std::mem::take(&mut self.constraints);
        for c in pending {
            let cty = self.apply(&c.ty);
            let mut cvars = HashSet::new();
            collect_vars(&cty, &mut cvars);
            if cvars.iter().any(|v| gen_set.contains(v)) {
                constraints.push(Constraint {
                    trait_name: c.trait_name,
                    ty: cty,
                });
            } else {
                // Constraint on non-generalised vars: keep solving later.
                self.constraints.push(Constraint {
                    trait_name: c.trait_name,
                    ty: cty,
                });
            }
        }
        Scheme {
            vars: gen_vars,
            constraints,
            ty: applied,
        }
    }

    /// Type-check the method bodies of a user `impl` against the trait's
    /// signatures (with the trait parameter substituted by the impl type).
    fn check_impl(&mut self, imp: &ImplDecl) {
        let Some(t) = self
            .ctx
            .traits
            .iter()
            .find(|t| t.name == imp.trait_name)
            .cloned()
        else {
            self.error(format!("unknown trait '{}'", imp.trait_name));
            return;
        };
        let env = self.ctx.env.clone();
        let mut map = HashMap::new();
        map.insert(t.param.clone(), imp.ty.clone());
        for b in &imp.methods {
            if let Pattern::Var(mname) = &b.pattern {
                match t.methods.iter().find(|(n, _)| n == mname) {
                    Some((_, msig)) => {
                        let expected = substitute_named(msig, &map);
                        let ty = self.infer(&b.value, &env);
                        self.unify_at(&ty, &expected, &format!("impl method '{mname}'"));
                    }
                    None => self.error(format!("'{mname}' is not a method of trait {}", t.name)),
                }
            }
        }
        self.solve_constraints();
    }

    // ----- constraint solving -----

    fn solve_constraints(&mut self) {
        let pending = std::mem::take(&mut self.constraints);
        for c in pending {
            let ty = self.apply(&c.ty);
            match self.constraint_status(&c.trait_name, &ty) {
                ConstraintStatus::Holds => {}
                ConstraintStatus::Fails => self.error(format!(
                    "no implementation of trait {} for type {}",
                    c.trait_name,
                    show_ty(&ty)
                )),
                ConstraintStatus::Unknown => {
                    // Still a type variable: defer (may be generalised).
                    self.constraints.push(Constraint {
                        trait_name: c.trait_name,
                        ty,
                    });
                }
            }
        }
    }

    fn constraint_status(&self, trait_name: &str, ty: &Ty) -> ConstraintStatus {
        if matches!(ty, Ty::Var(_)) {
            return ConstraintStatus::Unknown;
        }
        if let Some(holds) = builtin_impl_holds(trait_name, ty) {
            return if holds {
                ConstraintStatus::Holds
            } else {
                ConstraintStatus::Fails
            };
        }
        if let Some(head) = ty_head(ty) {
            if self
                .ctx
                .user_impls
                .contains(&(trait_name.to_string(), head))
            {
                return ConstraintStatus::Holds;
            }
        }
        ConstraintStatus::Fails
    }

    // ----- expression inference -----

    fn infer(&mut self, expr: &Expr, env: &HashMap<String, Scheme>) -> Ty {
        match expr {
            Expr::Num(_) => Ty::num(),
            Expr::Bool(_) => Ty::bool(),
            Expr::DurationSecs(_) => Ty::dur(),
            Expr::Str(segs) => {
                for seg in segs {
                    if let StrSeg::Expr(e) = seg {
                        let ty = self.infer(e, env);
                        self.constraints.push(Constraint {
                            trait_name: "Display".to_string(),
                            ty,
                        });
                    }
                }
                Ty::str()
            }
            Expr::Var(name) => match env.get(name) {
                Some(scheme) => self.instantiate(scheme),
                None => {
                    self.error(format!("unknown name '{name}'"));
                    self.fresh()
                }
            },
            Expr::Ctor(name) => match self.ctx.ctors.get(name) {
                Some(info) => self.instantiate(&info.scheme),
                None => {
                    self.error(format!("unknown constructor '{name}'"));
                    self.fresh()
                }
            },
            Expr::List(items) => {
                let elem = self.fresh();
                for it in items {
                    let ty = self.infer(it, env);
                    self.unify_at(&elem, &ty, "list element");
                }
                Ty::list(elem)
            }
            Expr::Tuple(items) => Ty::Tuple(items.iter().map(|e| self.infer(e, env)).collect()),
            Expr::Cons(head, tail) => {
                let ht = self.infer(head, env);
                let tt = self.infer(tail, env);
                self.unify_at(&tt, &Ty::list(ht.clone()), "list cons");
                Ty::list(ht)
            }
            Expr::Record(fields) => self.infer_record(fields, env),
            Expr::Field { base, field } => {
                let bt = self.infer(base, env);
                self.field_type(&bt, field)
            }
            Expr::TupleIndex { base, index } => {
                let bt = self.infer(base, env);
                match self.apply(&bt) {
                    Ty::Tuple(items) if *index < items.len() => items[*index].clone(),
                    other => {
                        self.error(format!("cannot take .{index} of type {}", show_ty(&other)));
                        self.fresh()
                    }
                }
            }
            Expr::Index { base, index } => {
                let bt = self.infer(base, env);
                let it = self.infer(index, env);
                self.unify_at(&it, &Ty::num(), "list index must be a Num");
                let elem = self.fresh();
                self.unify_at(&bt, &Ty::list(elem.clone()), "indexing requires a list");
                elem
            }
            Expr::Lambda { param, body } => {
                let pty = self.fresh();
                let mut inner = env.clone();
                inner.insert(param.clone(), Scheme::mono(pty.clone()));
                let bty = self.infer(body, &inner);
                Ty::func(pty, bty)
            }
            Expr::Apply { func, arg } => {
                let ft = self.infer(func, env);
                let at = self.infer(arg, env);
                let ret = self.fresh();
                self.unify_at(&ft, &Ty::func(at, ret.clone()), "function application");
                ret
            }
            Expr::If { cond, then, els } => {
                let ct = self.infer(cond, env);
                self.unify_at(&ct, &Ty::bool(), "if condition");
                let tt = self.infer(then, env);
                let et = self.infer(els, env);
                self.unify_at(&tt, &et, "if branches must agree");
                tt
            }
            Expr::Match { scrutinee, arms } => self.infer_match(scrutinee, arms, env),
            Expr::Block(items) => {
                for it in items {
                    let ty = self.infer(it, env);
                    self.unify_at(&ty, &Ty::action(), "action block element");
                }
                Ty::action()
            }
            Expr::Unary { op, expr } => {
                let t = self.infer(expr, env);
                match op {
                    UnaryOp::Not => {
                        self.unify_at(&t, &Ty::bool(), "'not' operand");
                        Ty::bool()
                    }
                    UnaryOp::Neg => {
                        let applied = self.apply(&t);
                        if matches!(&applied, Ty::Con(n, _) if n == "Dur") {
                            Ty::dur()
                        } else {
                            self.unify_at(&t, &Ty::num(), "negation operand");
                            Ty::num()
                        }
                    }
                }
            }
            Expr::Binary { op, left, right } => self.infer_binary(*op, left, right, env),
        }
    }

    fn infer_binary(
        &mut self,
        op: BinaryOp,
        left: &Expr,
        right: &Expr,
        env: &HashMap<String, Scheme>,
    ) -> Ty {
        let lt = self.infer(left, env);
        let rt = self.infer(right, env);
        match op {
            BinaryOp::And | BinaryOp::Or | BinaryOp::Xor => {
                self.unify_at(&lt, &Ty::bool(), "boolean operand");
                self.unify_at(&rt, &Ty::bool(), "boolean operand");
                Ty::bool()
            }
            BinaryOp::Eq | BinaryOp::Neq => {
                self.unify_at(&lt, &rt, "comparison operands must match");
                self.constraints.push(Constraint {
                    trait_name: "Eq".to_string(),
                    ty: lt,
                });
                Ty::bool()
            }
            BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
                self.unify_at(&lt, &rt, "comparison operands must match");
                self.constraints.push(Constraint {
                    trait_name: "Ord".to_string(),
                    ty: lt,
                });
                Ty::bool()
            }
            BinaryOp::Add | BinaryOp::Sub => {
                self.unify_at(&lt, &rt, "arithmetic operands must match");
                self.constraints.push(Constraint {
                    trait_name: "Arith".to_string(),
                    ty: lt.clone(),
                });
                lt
            }
            BinaryOp::Mod => {
                self.unify_at(&lt, &Ty::num(), "'%' operand");
                self.unify_at(&rt, &Ty::num(), "'%' operand");
                Ty::num()
            }
            BinaryOp::Mul => self.infer_mul_div(true, lt, rt),
            BinaryOp::Div => self.infer_mul_div(false, lt, rt),
        }
    }

    /// Duration-aware `*` / `/`. `mul`: Num*Num, Dur*Num, Num*Dur. `div`:
    /// Num/Num, Dur/Num, Dur/Dur.
    fn infer_mul_div(&mut self, is_mul: bool, lt: Ty, rt: Ty) -> Ty {
        let la = self.apply(&lt);
        let ra = self.apply(&rt);
        let is_dur = |t: &Ty| matches!(t, Ty::Con(n, _) if n == "Dur");
        if is_mul {
            if is_dur(&la) {
                self.unify_at(&rt, &Ty::num(), "Dur * Num");
                Ty::dur()
            } else if is_dur(&ra) {
                self.unify_at(&lt, &Ty::num(), "Num * Dur");
                Ty::dur()
            } else {
                self.unify_at(&lt, &Ty::num(), "'*' operand");
                self.unify_at(&rt, &Ty::num(), "'*' operand");
                Ty::num()
            }
        } else if is_dur(&la) {
            if is_dur(&ra) {
                Ty::num()
            } else {
                self.unify_at(&rt, &Ty::num(), "Dur / Num");
                Ty::dur()
            }
        } else {
            self.unify_at(&lt, &Ty::num(), "'/' operand");
            self.unify_at(&rt, &Ty::num(), "'/' operand");
            Ty::num()
        }
    }

    fn infer_record(&mut self, fields: &[(String, Expr)], env: &HashMap<String, Scheme>) -> Ty {
        let field_tys: Vec<(String, Ty)> = fields
            .iter()
            .map(|(name, e)| (name.clone(), self.infer(e, env)))
            .collect();
        let labels: HashSet<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
        // Find the record type whose fields exactly match the literal's labels.
        let mut chosen: Option<String> = None;
        for (rname, rdef) in &self.ctx.records {
            let rlabels: HashSet<&str> = rdef.fields.iter().map(|(n, _)| n.as_str()).collect();
            if rlabels == labels {
                chosen = Some(rname.clone());
                break;
            }
        }
        let Some(rname) = chosen else {
            self.error("record literal does not match any declared record type");
            return self.fresh();
        };
        let rdef = self.ctx.records[&rname].clone();
        // Instantiate record type parameters.
        let mut param_map: HashMap<String, Ty> = HashMap::new();
        let mut args = Vec::new();
        for p in &rdef.params {
            let f = self.fresh();
            param_map.insert(p.clone(), f.clone());
            args.push(f);
        }
        for (fname, fty) in &field_tys {
            let declared = rdef
                .fields
                .iter()
                .find(|(n, _)| n == fname)
                .map(|(_, t)| substitute_named(t, &param_map))
                .unwrap();
            self.unify_at(fty, &declared, &format!("record field '{fname}'"));
        }
        Ty::Con(rname, args)
    }

    fn field_type(&mut self, base: &Ty, field: &str) -> Ty {
        let applied = self.apply(base);
        if let Ty::Con(name, args) = &applied {
            if let Some(rdef) = self.ctx.records.get(name) {
                if let Some((_, fty)) = rdef.fields.iter().find(|(n, _)| n == field) {
                    let mut param_map = HashMap::new();
                    for (p, a) in rdef.params.iter().zip(args.iter()) {
                        param_map.insert(p.clone(), a.clone());
                    }
                    return substitute_named(fty, &param_map);
                }
                self.error(format!("type {name} has no field '{field}'"));
                return self.fresh();
            }
        }
        // Field access on an unresolved type: if exactly one declared record
        // type has this field, resolve the base to it (no row polymorphism).
        if matches!(applied, Ty::Var(_)) {
            if let Some(owners) = self.ctx.field_owner.get(field) {
                if owners.len() == 1 {
                    let rname = owners[0].clone();
                    let rdef = self.ctx.records[&rname].clone();
                    let mut param_map = HashMap::new();
                    let mut args = Vec::new();
                    for p in &rdef.params {
                        let f = self.fresh();
                        param_map.insert(p.clone(), f.clone());
                        args.push(f);
                    }
                    self.unify_at(&applied, &Ty::Con(rname, args), "field access");
                    let (_, fty) = rdef.fields.iter().find(|(n, _)| n == field).unwrap();
                    return substitute_named(fty, &param_map);
                }
                self.error(format!(
                    "field '{field}' is ambiguous; annotate the value's type"
                ));
                return self.fresh();
            }
        }
        self.error(format!(
            "cannot access field '{field}' on type {}",
            show_ty(&applied)
        ));
        self.fresh()
    }

    fn infer_match(
        &mut self,
        scrutinee: &Expr,
        arms: &[MatchArm],
        env: &HashMap<String, Scheme>,
    ) -> Ty {
        let scrut = self.infer(scrutinee, env);
        let result = self.fresh();
        for arm in arms {
            let mut inner = env.clone();
            let binds = self.check_pattern(&arm.pattern, &scrut);
            for (name, ty) in binds {
                inner.insert(name, Scheme::mono(ty));
            }
            let bty = self.infer(&arm.body, &inner);
            self.unify_at(&bty, &result, "match arms must agree");
        }
        self.check_exhaustive(&scrut, arms);
        result
    }

    fn check_exhaustive(&mut self, scrut: &Ty, arms: &[MatchArm]) {
        let has_catchall = arms
            .iter()
            .any(|a| matches!(a.pattern, Pattern::Wildcard | Pattern::Var(_)));
        if has_catchall {
            return;
        }
        let applied = self.apply(scrut);
        match &applied {
            Ty::Con(name, _) if self.ctx.enums.contains_key(name) => {
                let all: HashSet<&String> = self.ctx.enums[name].iter().collect();
                let mut covered: HashSet<&String> = HashSet::new();
                for a in arms {
                    if let Pattern::Variant { name, .. } = &a.pattern {
                        covered.insert(name);
                    }
                }
                let missing: Vec<String> = all.difference(&covered).map(|s| (*s).clone()).collect();
                if !missing.is_empty() {
                    self.error(format!(
                        "non-exhaustive match; missing: {}",
                        missing.join(", ")
                    ));
                }
            }
            Ty::Con(name, _) if name == "Bool" => {
                let has_true = arms
                    .iter()
                    .any(|a| matches!(a.pattern, Pattern::Bool(true)));
                let has_false = arms
                    .iter()
                    .any(|a| matches!(a.pattern, Pattern::Bool(false)));
                if !(has_true && has_false) {
                    self.error("non-exhaustive match on Bool; cover true and false or add '_'");
                }
            }
            Ty::Con(name, _) if name == "List" => {
                let has_nil = arms.iter().any(|a| {
                    matches!(a.pattern, Pattern::Nil)
                        || matches!(&a.pattern, Pattern::List(v) if v.is_empty())
                });
                let has_cons = arms.iter().any(|a| {
                    matches!(a.pattern, Pattern::Cons(_, _))
                        || matches!(&a.pattern, Pattern::List(v) if !v.is_empty())
                });
                if !(has_nil && has_cons) {
                    self.error("non-exhaustive match on a list; cover [] and x :: rest or add '_'");
                }
            }
            _ => {
                self.error("non-exhaustive match; add a '_' arm");
            }
        }
    }

    /// Check a pattern against an expected type, returning the variable bindings.
    fn check_pattern(&mut self, pat: &Pattern, expected: &Ty) -> Vec<(String, Ty)> {
        match pat {
            Pattern::Wildcard => vec![],
            Pattern::Var(name) => vec![(name.clone(), expected.clone())],
            Pattern::Num(_) => {
                self.unify_at(expected, &Ty::num(), "number pattern");
                vec![]
            }
            Pattern::Bool(_) => {
                self.unify_at(expected, &Ty::bool(), "bool pattern");
                vec![]
            }
            Pattern::Str(_) => {
                self.unify_at(expected, &Ty::str(), "string pattern");
                vec![]
            }
            Pattern::Dur(_) => {
                self.unify_at(expected, &Ty::dur(), "duration pattern");
                vec![]
            }
            Pattern::Tuple(ps) => {
                let elems: Vec<Ty> = ps.iter().map(|_| self.fresh()).collect();
                self.unify_at(expected, &Ty::Tuple(elems.clone()), "tuple pattern");
                let mut binds = Vec::new();
                for (p, t) in ps.iter().zip(elems.iter()) {
                    binds.extend(self.check_pattern(p, t));
                }
                binds
            }
            Pattern::Nil => {
                let e = self.fresh();
                self.unify_at(expected, &Ty::list(e), "'[]' pattern");
                vec![]
            }
            Pattern::Cons(head, tail) => {
                let e = self.fresh();
                self.unify_at(expected, &Ty::list(e.clone()), "'::' pattern");
                let mut binds = self.check_pattern(head, &e);
                binds.extend(self.check_pattern(tail, &Ty::list(e)));
                binds
            }
            Pattern::List(ps) => {
                let e = self.fresh();
                self.unify_at(expected, &Ty::list(e.clone()), "list pattern");
                let mut binds = Vec::new();
                for p in ps {
                    binds.extend(self.check_pattern(p, &e));
                }
                binds
            }
            Pattern::Variant { name, args } => {
                let Some(info) = self.ctx.ctors.get(name).cloned() else {
                    self.error(format!("unknown constructor '{name}'"));
                    return vec![];
                };
                if args.len() != info.arity {
                    self.error(format!(
                        "constructor '{name}' expects {} argument(s)",
                        info.arity
                    ));
                }
                let ctor_ty = self.instantiate(&info.scheme);
                // Peel argument types off the curried constructor type.
                let mut cur = ctor_ty;
                let mut arg_tys = Vec::new();
                for _ in 0..info.arity {
                    match self.resolve(&cur) {
                        Ty::Fun(a, b) => {
                            arg_tys.push(*a);
                            cur = *b;
                        }
                        _ => break,
                    }
                }
                self.unify_at(expected, &cur, &format!("constructor '{name}' pattern"));
                let mut binds = Vec::new();
                for (p, t) in args.iter().zip(arg_tys.iter()) {
                    binds.extend(self.check_pattern(p, t));
                }
                binds
            }
            Pattern::Record { fields, .. } => {
                let applied = self.apply(expected);
                let mut binds = Vec::new();
                if let Ty::Con(name, targs) = &applied {
                    if let Some(rdef) = self.ctx.records.get(name).cloned() {
                        let mut param_map = HashMap::new();
                        for (p, a) in rdef.params.iter().zip(targs.iter()) {
                            param_map.insert(p.clone(), a.clone());
                        }
                        for (fname, sub) in fields {
                            let fty = rdef
                                .fields
                                .iter()
                                .find(|(n, _)| n == fname)
                                .map(|(_, t)| substitute_named(t, &param_map));
                            let Some(fty) = fty else {
                                self.error(format!("type {name} has no field '{fname}'"));
                                continue;
                            };
                            match sub {
                                Some(p) => binds.extend(self.check_pattern(p, &fty)),
                                None => binds.push((fname.clone(), fty)),
                            }
                        }
                        return binds;
                    }
                }
                self.error("record pattern requires a known record type");
                binds
            }
        }
    }
}

enum ConstraintStatus {
    Holds,
    Fails,
    Unknown,
}

// ----- free variables & substitution helpers -----

fn collect_vars(ty: &Ty, out: &mut HashSet<u32>) {
    match ty {
        Ty::Var(v) => {
            out.insert(*v);
        }
        Ty::Con(_, args) => args.iter().for_each(|a| collect_vars(a, out)),
        Ty::Tuple(items) => items.iter().for_each(|a| collect_vars(a, out)),
        Ty::Fun(a, b) => {
            collect_vars(a, out);
            collect_vars(b, out);
        }
    }
}

fn collect_vars_ordered(ty: &Ty, out: &mut Vec<u32>, seen: &mut HashSet<u32>) {
    match ty {
        Ty::Var(v) => {
            if seen.insert(*v) {
                out.push(*v);
            }
        }
        Ty::Con(_, args) => args.iter().for_each(|a| collect_vars_ordered(a, out, seen)),
        Ty::Tuple(items) => items
            .iter()
            .for_each(|a| collect_vars_ordered(a, out, seen)),
        Ty::Fun(a, b) => {
            collect_vars_ordered(a, out, seen);
            collect_vars_ordered(b, out, seen);
        }
    }
}

fn subst_ids(ty: &Ty, map: &HashMap<u32, Ty>) -> Ty {
    match ty {
        Ty::Var(v) => map.get(v).cloned().unwrap_or(Ty::Var(*v)),
        Ty::Con(name, args) => Ty::Con(
            name.clone(),
            args.iter().map(|a| subst_ids(a, map)).collect(),
        ),
        Ty::Tuple(items) => Ty::Tuple(items.iter().map(|a| subst_ids(a, map)).collect()),
        Ty::Fun(a, b) => Ty::func(subst_ids(a, map), subst_ids(b, map)),
    }
}

fn substitute_named(ty: &Ty, map: &HashMap<String, Ty>) -> Ty {
    match ty {
        Ty::Con(name, args) if args.is_empty() && map.contains_key(name) => map[name].clone(),
        Ty::Con(name, args) => Ty::Con(
            name.clone(),
            args.iter().map(|a| substitute_named(a, map)).collect(),
        ),
        Ty::Tuple(items) => Ty::Tuple(items.iter().map(|a| substitute_named(a, map)).collect()),
        Ty::Fun(a, b) => Ty::func(substitute_named(a, map), substitute_named(b, map)),
        Ty::Var(v) => Ty::Var(*v),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn typecheck_program(
    program: Program,
    ctx: &TypeContext,
) -> Result<TypedProgram, Vec<Diagnostic>> {
    let mut ctx = ctx.clone();
    for decl in &program.decls {
        ctx.register_decl(decl);
    }
    let mut infer = Infer::new(&ctx);
    for decl in &program.decls {
        if let Decl::Impl(imp) = decl {
            infer.check_impl(imp);
        }
    }
    let env = ctx.env.clone();
    let env = match infer.check_bindings(&program.bindings, env) {
        Ok(env) => env,
        Err(()) => return Err(infer.errors),
    };
    let action_ty = infer.infer(&program.action, &env);
    infer.unify_at(
        &action_ty,
        &Ty::action(),
        "a policy must end with an Action",
    );
    infer.solve_constraints();
    if infer.errors.is_empty() {
        Ok(TypedProgram {
            decls: program.decls,
            bindings: program.bindings,
            action: program.action,
        })
    } else {
        Err(infer.errors)
    }
}

pub fn typecheck_expr(expr: &Expr, ctx: &TypeContext) -> Result<Ty, Vec<Diagnostic>> {
    let mut infer = Infer::new(ctx);
    let env = ctx.env.clone();
    let ty = infer.infer(expr, &env);
    infer.solve_constraints();
    if infer.errors.is_empty() {
        Ok(infer.apply(&ty))
    } else {
        Err(infer.errors)
    }
}

pub fn ty_to_string(ty: &Ty) -> String {
    show_ty(ty)
}

/// Render a type scheme like `Ord a => List<a> -> a`.
pub fn scheme_to_string(scheme: &Scheme) -> String {
    let mut names = HashMap::new();
    let mut counter = 0u32;
    let ty = show_ty_inner(&scheme.ty, &mut names, &mut counter);
    if scheme.constraints.is_empty() {
        return ty;
    }
    let cons: Vec<String> = scheme
        .constraints
        .iter()
        .map(|c| {
            format!(
                "{} {}",
                c.trait_name,
                show_ty_inner(&c.ty, &mut names, &mut counter)
            )
        })
        .collect();
    format!("{} => {}", cons.join(", "), ty)
}

fn show_ty(ty: &Ty) -> String {
    let mut names = HashMap::new();
    let mut counter = 0u32;
    show_ty_inner(ty, &mut names, &mut counter)
}

fn show_ty_inner(ty: &Ty, names: &mut HashMap<u32, String>, counter: &mut u32) -> String {
    match ty {
        Ty::Con(name, args) if args.is_empty() => name.clone(),
        Ty::Con(name, args) if name == "List" => {
            format!("List<{}>", show_ty_inner(&args[0], names, counter))
        }
        Ty::Con(name, args) => {
            let inner: Vec<String> = args
                .iter()
                .map(|a| show_ty_inner(a, names, counter))
                .collect();
            format!("{name}<{}>", inner.join(", "))
        }
        Ty::Tuple(items) => {
            let inner: Vec<String> = items
                .iter()
                .map(|a| show_ty_inner(a, names, counter))
                .collect();
            format!("({})", inner.join(", "))
        }
        Ty::Fun(a, b) => {
            let left = show_ty_inner(a, names, counter);
            let right = show_ty_inner(b, names, counter);
            if matches!(**a, Ty::Fun(_, _)) {
                format!("({left}) -> {right}")
            } else {
                format!("{left} -> {right}")
            }
        }
        Ty::Var(v) => names
            .entry(*v)
            .or_insert_with(|| {
                let name = letter_name(*counter);
                *counter += 1;
                name
            })
            .clone(),
    }
}

fn letter_name(n: u32) -> String {
    let letter = (b'a' + (n % 26) as u8) as char;
    if n < 26 {
        letter.to_string()
    } else {
        format!("{letter}{}", n / 26)
    }
}
