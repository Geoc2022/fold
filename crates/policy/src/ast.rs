use serde::{Deserialize, Serialize};

/// Types. Recursive to express `List<T>`, tuples, and functions (ML lineage:
/// algebraic types + `->`). `Var` is an inference variable (Damas–Milner).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ty {
    Num,
    Bool,
    Dur,
    Str,
    Unit,
    List(Box<Ty>),
    Tuple(Vec<Ty>),
    Fun(Box<Ty>, Box<Ty>),
    Var(u32),
    /// A user-declared nominal type (record or enum).
    Named(String),
}

impl Ty {
    pub fn list(inner: Ty) -> Ty {
        Ty::List(Box::new(inner))
    }
    pub fn func(from: Ty, to: Ty) -> Ty {
        Ty::Fun(Box::new(from), Box::new(to))
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Pattern {
    Wildcard,
    Num(f64),
    Bool(bool),
    Str(String),
    Dur(i64),
    /// A nullary enum constructor, e.g. `Red`.
    Variant(String),
}

/// A user-declared type (OCaml-style records and variant enums).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Decl {
    Record {
        name: String,
        fields: Vec<(String, Ty)>,
    },
    Enum {
        name: String,
        variants: Vec<String>,
    },
}

/// A top-level binding: either a simple `name = expr` or an OCaml-style record
/// destructuring `{ a; b; _ } = expr`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Binding {
    Simple {
        name: String,
        value: Expr,
    },
    Record {
        fields: Vec<String>,
        ignore_rest: bool,
        value: Expr,
    },
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
    Str(String),
    DurationSecs(i64),
    Var(String),
    Count(String),
    Tuple(Vec<Expr>),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Apply {
        func: Box<Expr>,
        arg: Box<Expr>,
    },
    Lambda {
        param: String,
        body: Box<Expr>,
    },
    Match {
        scrutinee: Box<Expr>,
        arms: Vec<MatchArm>,
    },
    TupleIndex {
        base: Box<Expr>,
        index: usize,
    },
    /// Record literal `{ field = expr; ... }`.
    Record {
        fields: Vec<(String, Expr)>,
    },
    /// Record field access `expr.field`.
    Field {
        base: Box<Expr>,
        field: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Channel {
    Notify,
    Node,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ActionSpec {
    Notify {
        message: Option<String>,
        after: Option<Expr>,
    },
    Commit,
    Interest,
    Lurk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub condition: Expr,
    pub action: ActionSpec,
}

/// A program is a set of type declarations, a sequence of bindings, and one rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Program {
    pub decls: Vec<Decl>,
    pub bindings: Vec<Binding>,
    pub rule: Rule,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedAction {
    pub spec: ActionSpec,
    pub channel: Channel,
}

/// Parse-don't-validate output: a program that has passed the type checker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedProgram {
    pub decls: Vec<Decl>,
    pub bindings: Vec<Binding>,
    pub condition: Expr,
    pub action: TypedAction,
}
