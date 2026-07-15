use crate::ast::{
    ActionSpec, BinaryOp, Binding, Decl, Expr, MatchArm, Pattern, Program, Rule, Ty, UnaryOp,
};
use crate::diag::{Diagnostic, Span};
use crate::lex::{lex, Token, TokenKind};

pub fn parse_program(input: &str) -> Result<Program, Vec<Diagnostic>> {
    let toks = lex(input)?;
    let mut p = Parser {
        tokens: toks,
        at: 0,
        errors: Vec::new(),
    };
    let program = p.parse_program();
    p.expect_eof();
    if p.errors.is_empty() {
        Ok(program)
    } else {
        Err(p.errors)
    }
}

/// Parse a standalone expression (used by the interactive terminal/REPL).
pub fn parse_expr_str(input: &str) -> Result<Expr, Vec<Diagnostic>> {
    let toks = lex(input)?;
    let mut p = Parser {
        tokens: toks,
        at: 0,
        errors: Vec::new(),
    };
    p.skip_newlines();
    let expr = p.parse_expr();
    p.expect_eof();
    if p.errors.is_empty() {
        Ok(expr)
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

    fn kind(&self) -> &TokenKind {
        &self.tokens[self.at].kind
    }

    fn peek_kind(&self, ahead: usize) -> &TokenKind {
        let idx = (self.at + ahead).min(self.tokens.len() - 1);
        &self.tokens[idx].kind
    }

    fn bump(&mut self) -> Token {
        let idx = self.at;
        self.at = (self.at + 1).min(self.tokens.len() - 1);
        self.tokens[idx].clone()
    }

    fn eat(&mut self, kind: &TokenKind) -> bool {
        if self.kind() == kind {
            self.bump();
            true
        } else {
            false
        }
    }

    fn skip_newlines(&mut self) {
        while matches!(self.kind(), TokenKind::Newline) {
            self.bump();
        }
    }

    fn error(&mut self, msg: impl Into<String>) {
        self.errors.push(Diagnostic::new(self.current().span, msg));
    }

    fn expect_eof(&mut self) {
        self.skip_newlines();
        if !matches!(self.kind(), TokenKind::Eof) {
            self.error("unexpected trailing input");
        }
    }

    /// program := (decl | binding)* rule
    fn parse_program(&mut self) -> Program {
        let mut decls = Vec::new();
        let mut bindings = Vec::new();
        self.skip_newlines();
        loop {
            if matches!(self.kind(), TokenKind::Type) {
                decls.push(self.parse_decl());
                self.finish_statement();
                continue;
            }
            // Record destructuring binding: `{ a; b; _ } = expr`.
            if matches!(self.kind(), TokenKind::LBrace) {
                bindings.push(self.parse_record_binding());
                self.finish_statement();
                continue;
            }
            // Simple binding `ident = expr` — lookahead for the `=`.
            if matches!(self.kind(), TokenKind::Ident(_))
                && matches!(self.peek_kind(1), TokenKind::Eq)
            {
                let name = match self.bump().kind {
                    TokenKind::Ident(s) => s,
                    _ => unreachable!(),
                };
                self.bump(); // '='
                let value = self.parse_expr();
                bindings.push(Binding::Simple { name, value });
                self.finish_statement();
                continue;
            }
            break;
        }
        let rule = self.parse_rule();
        self.skip_newlines();
        Program {
            decls,
            bindings,
            rule,
        }
    }

    fn finish_statement(&mut self) {
        if !matches!(self.kind(), TokenKind::Newline | TokenKind::Eof) {
            self.error("expected newline after statement");
        }
        self.skip_newlines();
    }

    /// decl := 'type' ident '=' ( record-body | enum-body )
    fn parse_decl(&mut self) -> Decl {
        self.bump(); // 'type'
        let name = self.expect_ident("expected type name");
        if !self.eat(&TokenKind::Eq) {
            self.error("expected '=' in type declaration");
        }
        self.skip_newlines();
        if matches!(self.kind(), TokenKind::LBrace) {
            let fields = self.parse_record_type_fields();
            Decl::Record { name, fields }
        } else {
            let variants = self.parse_enum_variants();
            Decl::Enum { name, variants }
        }
    }

    /// `{ field : type ; ... }` (`;` or newline separated).
    fn parse_record_type_fields(&mut self) -> Vec<(String, Ty)> {
        let mut fields = Vec::new();
        self.bump(); // '{'
        self.skip_field_separators();
        while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
            let field = self.expect_ident("expected field name");
            if !self.eat(&TokenKind::Colon) {
                self.error("expected ':' after field name");
            }
            let ty = self.parse_type();
            fields.push((field, ty));
            if !matches!(self.kind(), TokenKind::RBrace) {
                if matches!(self.kind(), TokenKind::Semi | TokenKind::Newline) {
                    self.skip_field_separators();
                } else {
                    self.error("expected ';' or newline between fields");
                }
            }
        }
        if !self.eat(&TokenKind::RBrace) {
            self.error("expected '}'");
        }
        fields
    }

    /// `A | B | C`
    fn parse_enum_variants(&mut self) -> Vec<String> {
        let mut variants = Vec::new();
        let _ = self.eat(&TokenKind::Pipe); // optional leading bar
        variants.push(self.expect_ident("expected variant name"));
        while self.eat(&TokenKind::Pipe) {
            variants.push(self.expect_ident("expected variant name"));
        }
        variants
    }

    fn parse_type(&mut self) -> Ty {
        let name = self.expect_ident("expected a type");
        match name.as_str() {
            "int" | "float" | "num" | "Num" => Ty::Num,
            "string" | "str" | "Str" => Ty::Str,
            "bool" | "Bool" => Ty::Bool,
            "dur" | "Dur" => Ty::Dur,
            _ => Ty::Named(name),
        }
    }

    /// `{ a; b; _ } = expr`
    fn parse_record_binding(&mut self) -> Binding {
        self.bump(); // '{'
        self.skip_field_separators();
        let mut fields = Vec::new();
        let mut ignore_rest = false;
        while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
            if matches!(self.kind(), TokenKind::Underscore) {
                self.bump();
                ignore_rest = true;
            } else {
                fields.push(self.expect_ident("expected field name in pattern"));
            }
            if !matches!(self.kind(), TokenKind::RBrace) {
                if matches!(self.kind(), TokenKind::Semi | TokenKind::Newline) {
                    self.skip_field_separators();
                } else {
                    self.error("expected ';' or newline between fields");
                }
            }
        }
        if !self.eat(&TokenKind::RBrace) {
            self.error("expected '}'");
        }
        if !self.eat(&TokenKind::Eq) {
            self.error("expected '=' after destructuring pattern");
        }
        let value = self.parse_expr();
        Binding::Record {
            fields,
            ignore_rest,
            value,
        }
    }

    fn skip_field_separators(&mut self) {
        while matches!(self.kind(), TokenKind::Semi | TokenKind::Newline) {
            self.bump();
        }
    }

    fn expect_ident(&mut self, msg: &str) -> String {
        match self.kind().clone() {
            TokenKind::Ident(s) => {
                self.bump();
                s
            }
            _ => {
                self.error(msg);
                String::new()
            }
        }
    }

    /// rule := expr '=>' action
    fn parse_rule(&mut self) -> Rule {
        let condition = self.parse_expr();
        if !self.eat(&TokenKind::FatArrow) {
            self.error("expected '=>' after condition");
        }
        let action = self.parse_action();
        Rule { condition, action }
    }

    fn parse_action(&mut self) -> ActionSpec {
        let name = match self.kind() {
            TokenKind::Ident(name) => {
                let out = name.clone();
                self.bump();
                out
            }
            _ => {
                self.error("expected action name");
                return ActionSpec::Notify {
                    message: None,
                    after: None,
                };
            }
        };
        match name.as_str() {
            "notify" => self.parse_notify(),
            "commit" => ActionSpec::Commit,
            "interest" => ActionSpec::Interest,
            "lurk" => ActionSpec::Lurk,
            other => {
                self.error(format!(
                    "unsupported action '{other}' (expected notify, commit, interest, lurk)"
                ));
                ActionSpec::Notify {
                    message: None,
                    after: None,
                }
            }
        }
    }

    fn parse_notify(&mut self) -> ActionSpec {
        let mut message = None;
        let mut after = None;

        if let TokenKind::Str(s) = self.kind() {
            message = Some(s.clone());
            self.bump();
        }

        if let TokenKind::Ident(word) = self.kind() {
            if word == "in" {
                self.bump();
                after = Some(self.parse_expr());
            }
        }

        if matches!(self.kind(), TokenKind::LParen) {
            self.bump();
            if !matches!(self.kind(), TokenKind::RParen) {
                loop {
                    let key = match self.kind() {
                        TokenKind::Ident(s) => {
                            let out = s.clone();
                            self.bump();
                            out
                        }
                        _ => {
                            self.error("expected action parameter name");
                            String::new()
                        }
                    };
                    if key == "after" {
                        if !self.eat(&TokenKind::Colon) {
                            self.error("expected ':' after 'after'");
                        }
                        let v = self.parse_expr();
                        if after.is_some() {
                            self.error("duplicate delay: use either 'in ...' or '(after: ...)'");
                        }
                        after = Some(v);
                    } else if key == "message" {
                        if !self.eat(&TokenKind::Colon) {
                            self.error("expected ':' after 'message'");
                        }
                        match self.kind() {
                            TokenKind::Str(s) => {
                                let msg = s.clone();
                                if message.is_some() {
                                    self.error("duplicate message");
                                }
                                message = Some(msg);
                                self.bump();
                            }
                            _ => self.error("notify message must be a quoted string"),
                        }
                    } else if !key.is_empty() {
                        self.error(format!("unsupported notify parameter '{key}'"));
                        let _ = self.parse_expr();
                    }
                    if self.eat(&TokenKind::Comma) {
                        continue;
                    }
                    break;
                }
            }
            if !self.eat(&TokenKind::RParen) {
                self.error("expected ')'");
            }
        }
        ActionSpec::Notify { message, after }
    }

    fn parse_expr(&mut self) -> Expr {
        // A `fun` lambda or `match` can appear as a full expression.
        if matches!(self.kind(), TokenKind::Fun) {
            return self.parse_lambda();
        }
        if matches!(self.kind(), TokenKind::Match) {
            return self.parse_match();
        }
        self.parse_or()
    }

    fn parse_lambda(&mut self) -> Expr {
        self.bump(); // 'fun'
        let param = match self.kind() {
            TokenKind::Ident(s) => {
                let out = s.clone();
                self.bump();
                out
            }
            TokenKind::Underscore => {
                self.bump();
                "_".to_string()
            }
            _ => {
                self.error("expected lambda parameter name");
                String::new()
            }
        };
        if !self.eat(&TokenKind::Arrow) {
            self.error("expected '->' in lambda");
        }
        let body = self.parse_expr();
        Expr::Lambda {
            param,
            body: Box::new(body),
        }
    }

    /// match := 'match' expr NEWLINE INDENT (pattern '=>' expr NEWLINE)+ DEDENT
    fn parse_match(&mut self) -> Expr {
        self.bump(); // 'match'
        let scrutinee = self.parse_or();
        if !self.eat(&TokenKind::Newline) {
            self.error("expected newline after match subject");
        }
        self.skip_newlines();
        let mut arms = Vec::new();
        if !self.eat(&TokenKind::Indent) {
            self.error("expected indented match arms");
            return Expr::Match {
                scrutinee: Box::new(scrutinee),
                arms,
            };
        }
        loop {
            self.skip_newlines();
            if matches!(self.kind(), TokenKind::Dedent | TokenKind::Eof) {
                break;
            }
            let pattern = self.parse_pattern();
            if !self.eat(&TokenKind::FatArrow) {
                self.error("expected '=>' in match arm");
            }
            let body = self.parse_expr();
            arms.push(MatchArm { pattern, body });
            if !matches!(self.kind(), TokenKind::Newline | TokenKind::Dedent | TokenKind::Eof) {
                self.error("expected newline after match arm");
            }
        }
        self.eat(&TokenKind::Dedent);
        Expr::Match {
            scrutinee: Box::new(scrutinee),
            arms,
        }
    }

    fn parse_pattern(&mut self) -> Pattern {
        match self.kind().clone() {
            TokenKind::Underscore => {
                self.bump();
                Pattern::Wildcard
            }
            TokenKind::Number(n) => {
                self.bump();
                Pattern::Num(n)
            }
            TokenKind::Minus => {
                self.bump();
                match self.kind().clone() {
                    TokenKind::Number(n) => {
                        self.bump();
                        Pattern::Num(-n)
                    }
                    TokenKind::DurationSecs(s) => {
                        self.bump();
                        Pattern::Dur(-s)
                    }
                    _ => {
                        self.error("expected number after '-' in pattern");
                        Pattern::Wildcard
                    }
                }
            }
            TokenKind::DurationSecs(s) => {
                self.bump();
                Pattern::Dur(s)
            }
            TokenKind::Str(s) => {
                self.bump();
                Pattern::Str(s)
            }
            TokenKind::True => {
                self.bump();
                Pattern::Bool(true)
            }
            TokenKind::False => {
                self.bump();
                Pattern::Bool(false)
            }
            TokenKind::Ident(name) => {
                self.bump();
                Pattern::Variant(name)
            }
            _ => {
                self.error("expected a literal pattern, variant, or '_'");
                self.bump();
                Pattern::Wildcard
            }
        }
    }

    fn parse_or(&mut self) -> Expr {
        let mut expr = self.parse_xor();
        while matches!(self.kind(), TokenKind::Or) {
            self.bump();
            let rhs = self.parse_xor();
            expr = bin(BinaryOp::Or, expr, rhs);
        }
        expr
    }

    fn parse_xor(&mut self) -> Expr {
        let mut expr = self.parse_and();
        while matches!(self.kind(), TokenKind::Xor) {
            self.bump();
            let rhs = self.parse_and();
            expr = bin(BinaryOp::Xor, expr, rhs);
        }
        expr
    }

    fn parse_and(&mut self) -> Expr {
        let mut expr = self.parse_cmp();
        while matches!(self.kind(), TokenKind::And) {
            self.bump();
            let rhs = self.parse_cmp();
            expr = bin(BinaryOp::And, expr, rhs);
        }
        expr
    }

    fn parse_cmp(&mut self) -> Expr {
        let mut expr = self.parse_add();
        loop {
            let op = match self.kind() {
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
                expr = bin(op, expr, rhs);
            } else {
                break;
            }
        }
        expr
    }

    fn parse_add(&mut self) -> Expr {
        let mut expr = self.parse_mul();
        loop {
            let op = match self.kind() {
                TokenKind::Plus => Some(BinaryOp::Add),
                TokenKind::Minus => Some(BinaryOp::Sub),
                _ => None,
            };
            if let Some(op) = op {
                self.bump();
                let rhs = self.parse_mul();
                expr = bin(op, expr, rhs);
            } else {
                break;
            }
        }
        expr
    }

    fn parse_mul(&mut self) -> Expr {
        let mut expr = self.parse_unary();
        loop {
            let op = match self.kind() {
                TokenKind::Star => Some(BinaryOp::Mul),
                TokenKind::Slash => Some(BinaryOp::Div),
                TokenKind::Percent => Some(BinaryOp::Mod),
                _ => None,
            };
            if let Some(op) = op {
                self.bump();
                let rhs = self.parse_unary();
                expr = bin(op, expr, rhs);
            } else {
                break;
            }
        }
        expr
    }

    fn parse_unary(&mut self) -> Expr {
        match self.kind() {
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
                match self.kind().clone() {
                    TokenKind::Ident(name) => {
                        self.bump();
                        Expr::Count(name)
                    }
                    _ => {
                        self.error("expected identifier after '#'");
                        Expr::Num(0.0)
                    }
                }
            }
            _ => self.parse_apply(),
        }
    }

    /// Application by juxtaposition (ML/OCaml): `f x`, and `f(a, b)` is `f`
    /// applied to the tuple `(a, b)`. A trailing tuple index binds to the whole
    /// application result, so `proj(x).1` means `(proj(x)).1` (C/JS-style).
    fn parse_apply(&mut self) -> Expr {
        let mut expr = self.parse_primary();
        while self.starts_argument() {
            let arg = self.parse_primary();
            expr = Expr::Apply {
                func: Box::new(expr),
                arg: Box::new(arg),
            };
        }
        self.parse_tuple_index(expr)
    }

    fn parse_tuple_index(&mut self, mut expr: Expr) -> Expr {
        while matches!(self.kind(), TokenKind::Dot) {
            self.bump();
            match self.kind().clone() {
                TokenKind::Number(n) if n.fract() == 0.0 && n >= 0.0 => {
                    self.bump();
                    expr = Expr::TupleIndex {
                        base: Box::new(expr),
                        index: n as usize,
                    };
                }
                TokenKind::Ident(field) => {
                    self.bump();
                    expr = Expr::Field {
                        base: Box::new(expr),
                        field,
                    };
                }
                _ => {
                    self.error("expected field name or tuple index after '.'");
                    break;
                }
            }
        }
        expr
    }

    /// A primary that can serve as a juxtaposed argument (no leading operators).
    fn starts_argument(&self) -> bool {
        matches!(
            self.kind(),
            TokenKind::Number(_)
                | TokenKind::DurationSecs(_)
                | TokenKind::Str(_)
                | TokenKind::True
                | TokenKind::False
                | TokenKind::Ident(_)
                | TokenKind::LParen
                | TokenKind::Fun
        )
    }

    fn parse_primary(&mut self) -> Expr {
        match self.kind().clone() {
            TokenKind::Number(n) => {
                self.bump();
                Expr::Num(n)
            }
            TokenKind::DurationSecs(secs) => {
                self.bump();
                Expr::DurationSecs(secs)
            }
            TokenKind::Str(s) => {
                self.bump();
                Expr::Str(s)
            }
            TokenKind::True => {
                self.bump();
                Expr::Bool(true)
            }
            TokenKind::False => {
                self.bump();
                Expr::Bool(false)
            }
            TokenKind::Fun => self.parse_lambda(),
            TokenKind::LBrace => self.parse_record_literal(),
            TokenKind::Ident(name) => {
                self.bump();
                Expr::Var(name)
            }
            TokenKind::LParen => {
                self.bump();
                let first = self.parse_expr();
                if matches!(self.kind(), TokenKind::Comma) {
                    let mut items = vec![first];
                    while self.eat(&TokenKind::Comma) {
                        if matches!(self.kind(), TokenKind::RParen) {
                            break;
                        }
                        items.push(self.parse_expr());
                    }
                    if !self.eat(&TokenKind::RParen) {
                        self.error("expected ')'");
                    }
                    Expr::Tuple(items)
                } else {
                    if !self.eat(&TokenKind::RParen) {
                        self.error("expected ')'");
                    }
                    first
                }
            }
            _ => {
                self.error("expected expression");
                self.bump();
                Expr::Num(0.0)
            }
        }
    }
}

impl Parser {
    /// `{ field = expr ; ... }` (`;` or newline separated).
    fn parse_record_literal(&mut self) -> Expr {
        self.bump(); // '{'
        self.skip_field_separators();
        let mut fields = Vec::new();
        while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
            let field = self.expect_ident("expected field name");
            if !self.eat(&TokenKind::Eq) {
                self.error("expected '=' in record field");
            }
            let value = self.parse_expr();
            fields.push((field, value));
            if !matches!(self.kind(), TokenKind::RBrace) {
                if matches!(self.kind(), TokenKind::Semi | TokenKind::Newline) {
                    self.skip_field_separators();
                } else {
                    self.error("expected ';' or newline between fields");
                }
            }
        }
        if !self.eat(&TokenKind::RBrace) {
            self.error("expected '}'");
        }
        Expr::Record { fields }
    }
}

fn bin(op: BinaryOp, left: Expr, right: Expr) -> Expr {
    Expr::Binary {
        op,
        left: Box::new(left),
        right: Box::new(right),
    }
}

#[allow(dead_code)]
fn _span_union(a: Span, b: Span) -> Span {
    Span::new(a.start.min(b.start), a.end.max(b.end))
}
