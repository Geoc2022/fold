use crate::ast::{ActionSpec, BinaryOp, Expr, Policy, UnaryOp};
use crate::diag::{Diagnostic, Span};
use crate::lex::{duration_secs, lex, Token, TokenKind};

pub fn parse_policy(input: &str) -> Result<Policy, Vec<Diagnostic>> {
    let toks = lex(input)?;
    let mut p = Parser {
        tokens: toks,
        at: 0,
        errors: Vec::new(),
    };
    let condition = p.parse_expr();
    p.expect_fat_arrow();
    let action = p.parse_action();
    p.expect_eof();
    if p.errors.is_empty() {
        Ok(Policy { condition, action })
    } else {
        Err(p.errors)
    }
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
    errors: Vec<Diagnostic>,
}

impl Parser {
    fn current(&self) -> &Token {
        &self.tokens[self.at]
    }

    fn bump(&mut self) -> &Token {
        let idx = self.at;
        self.at = (self.at + 1).min(self.tokens.len() - 1);
        &self.tokens[idx]
    }

    fn expect_fat_arrow(&mut self) {
        if !matches!(self.current().kind, TokenKind::FatArrow) {
            self.errors.push(Diagnostic::new(
                self.current().span,
                "expected '=>' after condition",
            ));
            return;
        }
        self.bump();
    }

    fn expect_eof(&mut self) {
        if !matches!(self.current().kind, TokenKind::Eof) {
            self.errors.push(Diagnostic::new(
                self.current().span,
                "unexpected trailing input",
            ));
        }
    }

    fn parse_action(&mut self) -> ActionSpec {
        let name = match &self.current().kind {
            TokenKind::Ident(name) => {
                let out = name.clone();
                self.bump();
                out
            }
            _ => {
                self.errors
                    .push(Diagnostic::new(self.current().span, "expected action name"));
                return ActionSpec::Notify {
                    message: None,
                    after: None,
                };
            }
        };
        if name != "notify" {
            self.errors.push(Diagnostic::new(
                self.current().span,
                format!("unsupported action '{name}' (for now only 'notify')"),
            ));
        }
        let mut message = None;
        let mut after = None;

        if let TokenKind::Str(s) = &self.current().kind {
            message = Some(s.clone());
            self.bump();
        }

        if let TokenKind::Ident(word) = &self.current().kind {
            if word == "in" {
                self.bump();
                after = Some(self.parse_expr());
            }
        }

        if matches!(self.current().kind, TokenKind::LParen) {
            self.bump();
            if !matches!(self.current().kind, TokenKind::RParen) {
                loop {
                    let key = match &self.current().kind {
                        TokenKind::Ident(s) => {
                            let out = s.clone();
                            self.bump();
                            out
                        }
                        _ => {
                            self.errors.push(Diagnostic::new(
                                self.current().span,
                                "expected action parameter name",
                            ));
                            String::new()
                        }
                    };
                    if key == "after" {
                        if matches!(self.current().kind, TokenKind::Colon) {
                            self.bump();
                        } else {
                            self.errors.push(Diagnostic::new(
                                self.current().span,
                                "expected ':' after 'after'",
                            ));
                        }
                        let v = self.parse_expr();
                        if after.is_some() {
                            self.errors.push(Diagnostic::new(
                                self.current().span,
                                "duplicate delay: use either 'in ...' or '(after: ...)'",
                            ));
                        }
                        after = Some(v);
                    } else if key == "message" {
                        if matches!(self.current().kind, TokenKind::Colon) {
                            self.bump();
                        } else {
                            self.errors.push(Diagnostic::new(
                                self.current().span,
                                "expected ':' after 'message'",
                            ));
                        }
                        match &self.current().kind {
                            TokenKind::Str(s) => {
                                let msg = s.clone();
                                if message.is_some() {
                                    self.errors.push(Diagnostic::new(
                                        self.current().span,
                                        "duplicate message",
                                    ));
                                }
                                message = Some(msg);
                                self.bump();
                            }
                            _ => self.errors.push(Diagnostic::new(
                                self.current().span,
                                "notify message must be a quoted string",
                            )),
                        }
                    } else if !key.is_empty() {
                        self.errors.push(Diagnostic::new(
                            self.current().span,
                            format!("unsupported notify parameter '{key}'"),
                        ));
                        let _ = self.parse_expr();
                    }
                    if matches!(self.current().kind, TokenKind::Comma) {
                        self.bump();
                        continue;
                    }
                    break;
                }
            }
            if matches!(self.current().kind, TokenKind::RParen) {
                self.bump();
            } else {
                self.errors
                    .push(Diagnostic::new(self.current().span, "expected ')'"));
            }
        }
        ActionSpec::Notify { message, after }
    }

    fn parse_expr(&mut self) -> Expr {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Expr {
        let mut expr = self.parse_xor();
        while matches!(self.current().kind, TokenKind::Or) {
            self.bump();
            let rhs = self.parse_xor();
            expr = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(expr),
                right: Box::new(rhs),
            };
        }
        expr
    }

    fn parse_xor(&mut self) -> Expr {
        let mut expr = self.parse_and();
        while matches!(self.current().kind, TokenKind::Xor) {
            self.bump();
            let rhs = self.parse_and();
            expr = Expr::Binary {
                op: BinaryOp::Xor,
                left: Box::new(expr),
                right: Box::new(rhs),
            };
        }
        expr
    }

    fn parse_and(&mut self) -> Expr {
        let mut expr = self.parse_cmp();
        while matches!(self.current().kind, TokenKind::And) {
            self.bump();
            let rhs = self.parse_cmp();
            expr = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(expr),
                right: Box::new(rhs),
            };
        }
        expr
    }

    fn parse_cmp(&mut self) -> Expr {
        let mut expr = self.parse_add();
        loop {
            let op = match self.current().kind {
                TokenKind::Lt => Some(BinaryOp::Lt),
                TokenKind::Lte => Some(BinaryOp::Lte),
                TokenKind::Gt => Some(BinaryOp::Gt),
                TokenKind::Gte => Some(BinaryOp::Gte),
                TokenKind::EqEq => Some(BinaryOp::Eq),
                TokenKind::Neq => Some(BinaryOp::Neq),
                _ => None,
            };
            if let Some(op) = op {
                self.bump();
                let rhs = self.parse_add();
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(rhs),
                };
            } else {
                break;
            }
        }
        expr
    }

    fn parse_add(&mut self) -> Expr {
        let mut expr = self.parse_mul();
        loop {
            let op = match self.current().kind {
                TokenKind::Plus => Some(BinaryOp::Add),
                TokenKind::Minus => Some(BinaryOp::Sub),
                _ => None,
            };
            if let Some(op) = op {
                self.bump();
                let rhs = self.parse_mul();
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(rhs),
                };
            } else {
                break;
            }
        }
        expr
    }

    fn parse_mul(&mut self) -> Expr {
        let mut expr = self.parse_unary();
        loop {
            let op = match self.current().kind {
                TokenKind::Star => Some(BinaryOp::Mul),
                TokenKind::Slash => Some(BinaryOp::Div),
                TokenKind::Percent => Some(BinaryOp::Mod),
                _ => None,
            };
            if let Some(op) = op {
                self.bump();
                let rhs = self.parse_unary();
                expr = Expr::Binary {
                    op,
                    left: Box::new(expr),
                    right: Box::new(rhs),
                };
            } else {
                break;
            }
        }
        expr
    }

    fn parse_unary(&mut self) -> Expr {
        match self.current().kind {
            TokenKind::Minus => {
                self.bump();
                Expr::Unary {
                    op: UnaryOp::Neg,
                    expr: Box::new(self.parse_unary()),
                }
            }
            TokenKind::Not => {
                self.bump();
                Expr::Unary {
                    op: UnaryOp::Not,
                    expr: Box::new(self.parse_unary()),
                }
            }
            TokenKind::Hash => {
                self.bump();
                match &self.current().kind {
                    TokenKind::Ident(name) => {
                        let out = Expr::Count(name.clone());
                        self.bump();
                        out
                    }
                    _ => {
                        self.errors.push(Diagnostic::new(
                            self.current().span,
                            "expected identifier after '#'",
                        ));
                        Expr::Num(0.0)
                    }
                }
            }
            _ => self.parse_postfix(),
        }
    }

    fn parse_postfix(&mut self) -> Expr {
        let mut expr = self.parse_primary();
        loop {
            match self.current().kind {
                TokenKind::Dot => {
                    self.bump();
                    let field = match &self.current().kind {
                        TokenKind::Ident(f) => {
                            let out = f.clone();
                            self.bump();
                            out
                        }
                        _ => {
                            self.errors.push(Diagnostic::new(
                                self.current().span,
                                "expected field name after '.'",
                            ));
                            String::new()
                        }
                    };
                    expr = Expr::Field {
                        base: Box::new(expr),
                        field,
                    };
                }
                TokenKind::LParen => {
                    let call_name = match expr {
                        Expr::Var(ref s) => Some(s.clone()),
                        _ => None,
                    };
                    if let Some(name) = call_name {
                        self.bump();
                        let mut args = Vec::new();
                        if !matches!(self.current().kind, TokenKind::RParen) {
                            loop {
                                args.push(self.parse_expr());
                                if matches!(self.current().kind, TokenKind::Comma) {
                                    self.bump();
                                    continue;
                                }
                                break;
                            }
                        }
                        if matches!(self.current().kind, TokenKind::RParen) {
                            self.bump();
                        } else {
                            self.errors
                                .push(Diagnostic::new(self.current().span, "expected ')'"));
                        }
                        expr = Expr::Call { name, args };
                    } else {
                        break;
                    }
                }
                _ => break,
            }
        }
        expr
    }

    fn parse_primary(&mut self) -> Expr {
        match &self.current().kind {
            TokenKind::Number(n) => {
                let out = *n;
                self.bump();
                if let TokenKind::Ident(unit) = &self.current().kind {
                    if let Some(secs) = duration_secs(out, unit) {
                        self.bump();
                        return Expr::DurationSecs(secs);
                    }
                }
                Expr::Num(out)
            }
            TokenKind::DurationSecs(secs) => {
                let out = *secs;
                self.bump();
                Expr::DurationSecs(out)
            }
            TokenKind::True => {
                self.bump();
                Expr::Bool(true)
            }
            TokenKind::False => {
                self.bump();
                Expr::Bool(false)
            }
            TokenKind::Ident(name) => {
                let out = Expr::Var(name.clone());
                self.bump();
                out
            }
            TokenKind::LParen => {
                self.bump();
                let e = self.parse_expr();
                if matches!(self.current().kind, TokenKind::RParen) {
                    self.bump();
                } else {
                    self.errors
                        .push(Diagnostic::new(self.current().span, "expected ')'"));
                }
                e
            }
            _ => {
                let span = self.current().span;
                self.errors
                    .push(Diagnostic::new(span, "expected expression"));
                self.bump();
                Expr::Num(0.0)
            }
        }
    }
}

#[allow(dead_code)]
fn _span_union(a: Span, b: Span) -> Span {
    Span::new(a.start.min(b.start), a.end.max(b.end))
}
