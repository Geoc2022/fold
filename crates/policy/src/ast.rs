use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ty {
    Num,
    Bool,
    Dur,
    Time,
    Day,
    State,
    Person,
    List,
    Action,
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
pub enum Expr {
    Num(f64),
    Bool(bool),
    DurationSecs(i64),
    Var(String),
    Count(String),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    pub condition: Expr,
    pub action: ActionSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedAction {
    pub spec: ActionSpec,
    pub channel: Channel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TypedPolicy {
    pub condition: Expr,
    pub action: TypedAction,
}
