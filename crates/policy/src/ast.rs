use serde::{Deserialize, Serialize};

/// Types. `Con(name, args)` is a (possibly parametric) type constructor:
/// `Num` = `Con("Num", [])`, `List<T>` = `Con("List", [T])`,
/// `Option<a>` = `Con("Option", [a])`. `Var` is an inference variable
/// (Damas–Milner). Functions are curried (`Fun(a, b)`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Ty {
    Con(String, Vec<Ty>),
    Tuple(Vec<Ty>),
    Fun(Box<Ty>, Box<Ty>),
    Var(u32),
}

impl Ty {
    pub fn con(name: &str) -> Ty {
        Ty::Con(name.to_string(), Vec::new())
    }
    pub fn num() -> Ty {
        Ty::con("Num")
    }
    pub fn bool() -> Ty {
        Ty::con("Bool")
    }
    pub fn dur() -> Ty {
        Ty::con("Dur")
    }
    pub fn str() -> Ty {
        Ty::con("Str")
    }
    pub fn action() -> Ty {
        Ty::con("Action")
    }
    pub fn list(inner: Ty) -> Ty {
        Ty::Con("List".to_string(), vec![inner])
    }
    pub fn func(from: Ty, to: Ty) -> Ty {
        Ty::Fun(Box::new(from), Box::new(to))
    }
    /// Build a curried function type from a list of argument types and a result.
    pub fn arrow(args: &[Ty], result: Ty) -> Ty {
        let mut ty = result;
        for a in args.iter().rev() {
            ty = Ty::func(a.clone(), ty);
        }
        ty
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnaryOp {
    Neg,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
    Neq,
    And,
    Or,
    Xor,
}

/// A segment of an interpolated string literal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum StrSeg {
    Lit(String),
    Expr(Expr),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Pattern {
    Wildcard,
    Var(String),
    Num(f64),
    Bool(bool),
    Str(String),
    Dur(i64),
    Tuple(Vec<Pattern>),
    /// `{ a, b }` or `{ a = p, b = q }`. `None` sub-pattern = bind field name.
    Record {
        fields: Vec<(String, Option<Pattern>)>,
        rest: bool,
    },
    /// `Some(x)`, `None`, `Committed(d)`.
    Variant {
        name: String,
        args: Vec<Pattern>,
    },
    /// `[]`.
    Nil,
    /// `x :: rest`.
    Cons(Box<Pattern>, Box<Pattern>),
    /// `[a, b, c]`.
    List(Vec<Pattern>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchArm {
    pub pattern: Pattern,
    pub body: Expr,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Expr {
    Num(f64),
    Bool(bool),
    DurationSecs(i64),
    Str(Vec<StrSeg>),
    Var(String),
    /// Uppercase constructor reference (`None`, `Some`, `Mon`, `Committed`).
    Ctor(String),
    List(Vec<Expr>),
    Tuple(Vec<Expr>),
    Record(Vec<(String, Expr)>),
    Field {
        base: Box<Expr>,
        field: String,
    },
    TupleIndex {
        base: Box<Expr>,
        index: usize,
    },
    Lambda {
        param: String,
        body: Box<Expr>,
    },
    Apply {
        func: Box<Expr>,
        arg: Box<Expr>,
    },
    If {
        cond: Box<Expr>,
        then: Box<Expr>,
        els: Box<Expr>,
    },
    Match {
        scrutinee: Box<Expr>,
        arms: Vec<MatchArm>,
    },
    /// Sequenced effect block `{ a1, a2, ... }`.
    Block(Vec<Expr>),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// `a :: b` list cons.
    Cons(Box<Expr>, Box<Expr>),
}

/// A constructor of a variant type, e.g. `Some(a)` in `Option<a>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariantDef {
    pub name: String,
    pub args: Vec<Ty>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TypeBody {
    Record(Vec<(String, Ty)>),
    Variant(Vec<VariantDef>),
    Alias(Ty),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypeDecl {
    pub doc: Option<String>,
    pub name: String,
    pub params: Vec<String>,
    pub body: TypeBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraitDecl {
    pub doc: Option<String>,
    pub name: String,
    pub param: String,
    pub methods: Vec<(String, Ty)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImplDecl {
    pub trait_name: String,
    pub ty: Ty,
    pub methods: Vec<Binding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Decl {
    Type(TypeDecl),
    Trait(TraitDecl),
    Impl(ImplDecl),
}

/// A binding: `pattern = value`. When `pattern` is a bare variable and `value`
/// is a lambda, the name is in scope inside `value` (self-recursion).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub doc: Option<String>,
    pub pattern: Pattern,
    pub value: Expr,
}

/// A program: type/trait/impl declarations, bindings, and a final expression
/// that produces an `Action`. `condition => action` is sugar for
/// `if condition then action else {}` (do nothing).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Program {
    pub decls: Vec<Decl>,
    pub bindings: Vec<Binding>,
    pub action: Expr,
}

/// Parse-don't-validate output: a program that has passed the type checker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedProgram {
    pub decls: Vec<Decl>,
    pub bindings: Vec<Binding>,
    pub action: Expr,
}
