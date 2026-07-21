use crate::ast::{
    BinaryOp, Binding, Decl, Expr, ImplDecl, MatchArm, Pattern, Program, StrSeg, TraitDecl, Ty,
    TypeBody, TypeDecl, UnaryOp, VariantDef,
};
use crate::diag::{Diagnostic, Span};
use crate::lex::{lex, StrPart, Token, TokenKind};

pub fn parse_program(input: &str) -> Result<Program, Vec<Diagnostic>> {
    let toks = lex(input)?;
    let mut p = Parser::new(toks);
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
    let mut p = Parser::new(toks);
    p.skip_layout();
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
    fn new(tokens: Vec<Token>) -> Self {
        Parser {
            tokens,
            at: 0,
            errors: Vec::new(),
        }
    }

    fn kind(&self) -> &TokenKind {
        &self.tokens[self.at].kind
    }

    fn span(&self) -> Span {
        self.tokens[self.at].span
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

    fn expect(&mut self, kind: &TokenKind, what: &str) {
        if !self.eat(kind) {
            self.error(format!("expected {what}"));
        }
    }

    fn skip_newlines(&mut self) {
        while matches!(self.kind(), TokenKind::Newline) {
            self.bump();
        }
    }

    /// Skip newline / indent / dedent tokens (used inside brackets and match).
    fn skip_layout(&mut self) {
        while matches!(
            self.kind(),
            TokenKind::Newline | TokenKind::Indent | TokenKind::Dedent
        ) {
            self.bump();
        }
    }

    fn error(&mut self, msg: impl Into<String>) {
        self.errors.push(Diagnostic::new(self.span(), msg));
    }

    fn expect_eof(&mut self) {
        self.skip_layout();
        if !matches!(self.kind(), TokenKind::Eof) {
            self.error("unexpected trailing input");
        }
    }

    fn finish_statement(&mut self) {
        self.skip_layout();
    }

    fn take_doc(&mut self) -> Option<String> {
        let mut doc = None;
        while let TokenKind::DocComment(text) = self.kind() {
            doc = Some(text.clone());
            self.bump();
            self.skip_newlines();
        }
        doc
    }

    // ----- program -----

    fn parse_program(&mut self) -> Program {
        let mut decls = Vec::new();
        let mut bindings = Vec::new();
        let mut action: Option<Expr> = None;
        self.skip_layout();
        loop {
            self.skip_layout();
            if matches!(self.kind(), TokenKind::Eof) {
                break;
            }
            let doc = self.take_doc();
            self.skip_layout();
            if matches!(self.kind(), TokenKind::Eof) {
                break;
            }
            match self.kind() {
                TokenKind::Type => {
                    decls.push(Decl::Type(self.parse_type_decl(doc)));
                }
                TokenKind::Trait => {
                    decls.push(Decl::Trait(self.parse_trait_decl(doc)));
                }
                TokenKind::Impl => {
                    decls.push(Decl::Impl(self.parse_impl_decl()));
                }
                _ if self.looks_like_binding() => {
                    bindings.push(self.parse_binding(doc));
                }
                _ => {
                    // The final expression: an Action. `cond => act` is sugar
                    // for `if cond then act else {}` (do nothing).
                    let expr = self.parse_expr();
                    action = Some(if self.eat(&TokenKind::FatArrow) {
                        let then = self.parse_expr();
                        Expr::If {
                            cond: Box::new(expr),
                            then: Box::new(then),
                            els: Box::new(Expr::Block(Vec::new())),
                        }
                    } else {
                        expr
                    });
                }
            }
            self.finish_statement();
            if action.is_some() {
                break;
            }
        }
        let action = action.unwrap_or_else(|| {
            self.error("a policy must end with an action (an expression of type Action)");
            Expr::Block(Vec::new())
        });
        Program {
            decls,
            bindings,
            action,
        }
    }

    fn looks_like_binding(&self) -> bool {
        let toks = &self.tokens;
        let mut k = self.at;
        match &toks[k].kind {
            TokenKind::LBrace | TokenKind::LParen | TokenKind::LBracket => {
                let mut depth = 0i32;
                loop {
                    match &toks[k].kind {
                        TokenKind::LParen | TokenKind::LBracket | TokenKind::LBrace => depth += 1,
                        TokenKind::RParen | TokenKind::RBracket | TokenKind::RBrace => {
                            depth -= 1;
                            if depth == 0 {
                                k += 1;
                                break;
                            }
                        }
                        TokenKind::Eof => return false,
                        _ => {}
                    }
                    k += 1;
                }
                while matches!(toks[k].kind, TokenKind::Newline) {
                    k += 1;
                }
                matches!(toks[k].kind, TokenKind::Eq)
            }
            TokenKind::Ident(_) => {
                k += 1;
                while matches!(toks[k].kind, TokenKind::Ident(_) | TokenKind::Underscore) {
                    k += 1;
                }
                matches!(toks[k].kind, TokenKind::Eq)
            }
            _ => false,
        }
    }

    fn parse_binding(&mut self, doc: Option<String>) -> Binding {
        // Destructuring binding: `{ ... } = e` or `( ... ) = e`.
        if matches!(
            self.kind(),
            TokenKind::LBrace | TokenKind::LParen | TokenKind::LBracket
        ) {
            let pattern = self.parse_pattern();
            self.expect(&TokenKind::Eq, "'=' in binding");
            self.skip_layout();
            let value = self.parse_expr();
            return Binding {
                doc,
                pattern,
                value,
            };
        }
        // `name arg1 arg2 = body` (function sugar) or `name = expr`.
        let name = self.expect_ident("binding name");
        let mut args: Vec<String> = Vec::new();
        loop {
            match self.kind() {
                TokenKind::Ident(_) => args.push(self.expect_ident("parameter")),
                TokenKind::Underscore => {
                    self.bump();
                    args.push(format!("_arg{}", args.len()));
                }
                _ => break,
            }
        }
        self.expect(&TokenKind::Eq, "'=' in binding");
        // Allow the binding's value to begin on an indented next line.
        self.skip_layout();
        let mut value = self.parse_expr();
        for param in args.into_iter().rev() {
            value = Expr::Lambda {
                param,
                body: Box::new(value),
            };
        }
        Binding {
            doc,
            pattern: Pattern::Var(name),
            value,
        }
    }

    // ----- declarations -----

    fn parse_type_decl(&mut self, doc: Option<String>) -> TypeDecl {
        self.bump(); // 'type'
        let name = self.expect_uident("type name");
        let mut params = Vec::new();
        if self.eat(&TokenKind::Lt) {
            loop {
                params.push(self.expect_ident("type parameter"));
                if !self.eat(&TokenKind::Comma) {
                    break;
                }
            }
            self.expect(&TokenKind::Gt, "'>' after type parameters");
        }
        self.expect(&TokenKind::Eq, "'=' in type declaration");
        let body = self.parse_type_body();
        TypeDecl {
            doc,
            name,
            params,
            body,
        }
    }

    fn parse_type_body(&mut self) -> TypeBody {
        if matches!(self.kind(), TokenKind::LBrace) {
            return TypeBody::Record(self.parse_record_ty_fields());
        }
        let is_variant = matches!(self.kind(), TokenKind::Pipe)
            || (matches!(self.kind(), TokenKind::UIdent(_))
                && matches!(self.peek_kind(1), TokenKind::Pipe | TokenKind::LParen));
        if is_variant {
            self.parse_variant_body()
        } else {
            TypeBody::Alias(self.parse_ty())
        }
    }

    fn parse_record_ty_fields(&mut self) -> Vec<(String, Ty)> {
        self.expect(&TokenKind::LBrace, "'{'");
        let mut fields = Vec::new();
        self.skip_newlines();
        while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
            let name = self.expect_ident("field name");
            self.expect(&TokenKind::Colon, "':' after field name");
            let ty = self.parse_ty();
            fields.push((name, ty));
            self.skip_separators();
        }
        self.expect(&TokenKind::RBrace, "'}'");
        fields
    }

    fn parse_variant_body(&mut self) -> TypeBody {
        let mut variants = Vec::new();
        self.eat(&TokenKind::Pipe); // optional leading pipe
        loop {
            let name = self.expect_uident("variant name");
            let mut args = Vec::new();
            if self.eat(&TokenKind::LParen) {
                loop {
                    args.push(self.parse_ty());
                    if !self.eat(&TokenKind::Comma) {
                        break;
                    }
                }
                self.expect(&TokenKind::RParen, "')'");
            }
            variants.push(VariantDef { name, args });
            if !self.eat(&TokenKind::Pipe) {
                break;
            }
        }
        TypeBody::Variant(variants)
    }

    fn parse_trait_decl(&mut self, doc: Option<String>) -> TraitDecl {
        self.bump(); // 'trait'
        let name = self.expect_uident("trait name");
        self.expect(&TokenKind::Lt, "'<' after trait name");
        let param = self.expect_ident("trait type parameter");
        self.expect(&TokenKind::Gt, "'>' after trait parameter");
        self.expect(&TokenKind::LBrace, "'{'");
        let mut methods = Vec::new();
        self.skip_newlines();
        while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
            let m = self.expect_ident("method name");
            self.expect(&TokenKind::Colon, "':' after method name");
            let ty = self.parse_ty();
            methods.push((m, ty));
            self.skip_separators();
        }
        self.expect(&TokenKind::RBrace, "'}'");
        TraitDecl {
            doc,
            name,
            param,
            methods,
        }
    }

    fn parse_impl_decl(&mut self) -> ImplDecl {
        self.bump(); // 'impl'
        let trait_name = self.expect_uident("trait name");
        self.expect(&TokenKind::Lt, "'<' after trait name");
        let ty = self.parse_ty();
        self.expect(&TokenKind::Gt, "'>' after impl type");
        self.expect(&TokenKind::LBrace, "'{'");
        let mut methods = Vec::new();
        self.skip_newlines();
        while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
            let doc = self.take_doc();
            methods.push(self.parse_binding(doc));
            self.skip_separators();
        }
        self.expect(&TokenKind::RBrace, "'}'");
        ImplDecl {
            trait_name,
            ty,
            methods,
        }
    }

    // ----- types -----

    fn parse_ty(&mut self) -> Ty {
        let atom = self.parse_ty_atom();
        if self.eat(&TokenKind::Arrow) {
            Ty::func(atom, self.parse_ty())
        } else {
            atom
        }
    }

    fn parse_ty_atom(&mut self) -> Ty {
        match self.kind().clone() {
            TokenKind::UIdent(name) => {
                self.bump();
                let mut args = Vec::new();
                if self.eat(&TokenKind::Lt) {
                    loop {
                        args.push(self.parse_ty());
                        if !self.eat(&TokenKind::Comma) {
                            break;
                        }
                    }
                    self.expect(&TokenKind::Gt, "'>' after type arguments");
                }
                Ty::Con(name, args)
            }
            TokenKind::Ident(name) => {
                // lowercase => type variable (represented as a nullary Con)
                self.bump();
                Ty::Con(name, Vec::new())
            }
            TokenKind::LBracket => {
                self.bump();
                let inner = self.parse_ty();
                self.expect(&TokenKind::RBracket, "']'");
                Ty::list(inner)
            }
            TokenKind::LParen => {
                self.bump();
                let mut items = vec![self.parse_ty()];
                while self.eat(&TokenKind::Comma) {
                    items.push(self.parse_ty());
                }
                self.expect(&TokenKind::RParen, "')'");
                if items.len() == 1 {
                    items.pop().unwrap()
                } else {
                    Ty::Tuple(items)
                }
            }
            _ => {
                self.error("expected a type");
                Ty::Var(u32::MAX)
            }
        }
    }

    // ----- expressions -----

    fn parse_expr(&mut self) -> Expr {
        match self.kind() {
            TokenKind::If => self.parse_if(),
            TokenKind::Match => self.parse_match(),
            TokenKind::Fun => self.parse_fun(),
            _ => self.parse_or(),
        }
    }

    fn parse_if(&mut self) -> Expr {
        self.bump();
        self.skip_layout();
        let cond = Box::new(self.parse_expr());
        self.skip_layout();
        self.expect(&TokenKind::Then, "'then'");
        // The then/else branches may be written on indented next lines.
        self.skip_layout();
        let then = Box::new(self.parse_expr());
        self.skip_layout();
        self.expect(&TokenKind::Else, "'else'");
        self.skip_layout();
        let els = Box::new(self.parse_expr());
        Expr::If { cond, then, els }
    }

    fn parse_fun(&mut self) -> Expr {
        self.bump();
        let mut params = Vec::new();
        while let TokenKind::Ident(_) = self.kind() {
            params.push(self.expect_ident("parameter"));
        }
        if params.is_empty() {
            self.error("expected at least one parameter after 'fun'");
        }
        self.expect(&TokenKind::Arrow, "'->' after parameters");
        self.skip_layout();
        let mut body = self.parse_expr();
        for param in params.into_iter().rev() {
            body = Expr::Lambda {
                param,
                body: Box::new(body),
            };
        }
        body
    }

    fn parse_match(&mut self) -> Expr {
        self.bump();
        let scrutinee = Box::new(self.parse_expr());
        self.expect(&TokenKind::With, "'with' after match scrutinee");
        let mut arms = Vec::new();
        loop {
            self.skip_layout();
            if !matches!(self.kind(), TokenKind::Pipe) {
                break;
            }
            self.bump(); // '|'
            let pattern = self.parse_pattern();
            self.expect(&TokenKind::Arrow, "'->' in match arm");
            self.skip_layout();
            let body = self.parse_expr();
            arms.push(MatchArm { pattern, body });
        }
        if arms.is_empty() {
            self.error("match needs at least one '| pattern -> expr' arm");
        }
        Expr::Match { scrutinee, arms }
    }

    fn parse_or(&mut self) -> Expr {
        let mut left = self.parse_and();
        loop {
            let op = match self.kind() {
                TokenKind::Or => BinaryOp::Or,
                TokenKind::Xor => BinaryOp::Xor,
                _ => break,
            };
            self.bump();
            let right = self.parse_and();
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_and(&mut self) -> Expr {
        let mut left = self.parse_not();
        while matches!(self.kind(), TokenKind::And) {
            self.bump();
            let right = self.parse_not();
            left = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_not(&mut self) -> Expr {
        if matches!(self.kind(), TokenKind::Not) {
            self.bump();
            Expr::Unary {
                op: UnaryOp::Not,
                expr: Box::new(self.parse_not()),
            }
        } else {
            self.parse_cmp()
        }
    }

    fn parse_cmp(&mut self) -> Expr {
        let left = self.parse_cons();
        let op = match self.kind() {
            TokenKind::Lt => BinaryOp::Lt,
            TokenKind::Lte => BinaryOp::Lte,
            TokenKind::Gt => BinaryOp::Gt,
            TokenKind::Gte => BinaryOp::Gte,
            TokenKind::EqEq => BinaryOp::Eq,
            TokenKind::Neq => BinaryOp::Neq,
            _ => return left,
        };
        self.bump();
        let right = self.parse_cons();
        Expr::Binary {
            op,
            left: Box::new(left),
            right: Box::new(right),
        }
    }

    fn parse_cons(&mut self) -> Expr {
        let left = self.parse_add();
        if self.eat(&TokenKind::ColonColon) {
            let right = self.parse_cons();
            Expr::Cons(Box::new(left), Box::new(right))
        } else {
            left
        }
    }

    fn parse_add(&mut self) -> Expr {
        let mut left = self.parse_mul();
        loop {
            let op = match self.kind() {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.bump();
            let right = self.parse_mul();
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_mul(&mut self) -> Expr {
        let mut left = self.parse_unary();
        loop {
            let op = match self.kind() {
                TokenKind::Star => BinaryOp::Mul,
                TokenKind::Slash => BinaryOp::Div,
                TokenKind::Percent => BinaryOp::Mod,
                _ => break,
            };
            self.bump();
            let right = self.parse_unary();
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_unary(&mut self) -> Expr {
        if matches!(self.kind(), TokenKind::Minus) {
            self.bump();
            Expr::Unary {
                op: UnaryOp::Neg,
                expr: Box::new(self.parse_unary()),
            }
        } else {
            self.parse_app()
        }
    }

    fn parse_app(&mut self) -> Expr {
        let mut func = self.parse_postfix();
        loop {
            if self.eat(&TokenKind::Before) {
                let target = self.parse_expr();
                self.expect(&TokenKind::By, "'by' after 'before ...'");
                let lead = self.parse_expr();
                func = self.desugar_before_by(func, target, lead);
                continue;
            }
            if !self.starts_atom() {
                break;
            }
            let arg = self.parse_postfix();
            func = Expr::Apply {
                func: Box::new(func),
                arg: Box::new(arg),
            };
        }
        func
    }

    fn desugar_before_by(&self, action: Expr, target: Expr, lead: Expr) -> Expr {
        let t = "_ready_in".to_string();
        let delayed = Expr::Apply {
            func: Box::new(Expr::Apply {
                func: Box::new(Expr::Var("delay".to_string())),
                arg: Box::new(action),
            }),
            arg: Box::new(Expr::Binary {
                op: BinaryOp::Sub,
                left: Box::new(Expr::Var(t.clone())),
                right: Box::new(lead),
            }),
        };
        Expr::Match {
            scrutinee: Box::new(target),
            arms: vec![
                MatchArm {
                    pattern: Pattern::Variant {
                        name: "Some".to_string(),
                        args: vec![Pattern::Var(t)],
                    },
                    body: delayed,
                },
                MatchArm {
                    pattern: Pattern::Variant {
                        name: "None".to_string(),
                        args: vec![],
                    },
                    body: Expr::Block(Vec::new()),
                },
            ],
        }
    }

    fn starts_atom(&self) -> bool {
        matches!(
            self.kind(),
            TokenKind::Number(_)
                | TokenKind::DurationSecs(_)
                | TokenKind::Str(_)
                | TokenKind::True
                | TokenKind::False
                | TokenKind::Ident(_)
                | TokenKind::UIdent(_)
                | TokenKind::Hash
                | TokenKind::LParen
                | TokenKind::LBracket
                | TokenKind::LBrace
        )
    }

    fn parse_postfix(&mut self) -> Expr {
        let mut base = self.parse_atom();
        loop {
            match self.kind().clone() {
                TokenKind::Dot => {
                    self.bump();
                    match self.kind().clone() {
                        TokenKind::Ident(field) => {
                            self.bump();
                            base = Expr::Field {
                                base: Box::new(base),
                                field,
                            };
                        }
                        TokenKind::Number(n) if n.fract() == 0.0 && n >= 0.0 => {
                            self.bump();
                            base = Expr::TupleIndex {
                                base: Box::new(base),
                                index: n as usize,
                            };
                        }
                        _ => {
                            self.error("expected a field name or tuple index after '.'");
                            break;
                        }
                    }
                }
                TokenKind::LBracket => {
                    // Disambiguate postfix indexing (`list[0]`) from applying
                    // a function to a list literal (`f [1, 2]`). We only treat
                    // `[...]` as an index when the bracket contents have no
                    // top-level comma; otherwise leave it for parse_app's
                    // argument parsing.
                    if !self.bracket_looks_like_index() {
                        break;
                    }
                    self.bump();
                    self.skip_newlines();
                    let index = self.parse_expr();
                    self.skip_newlines();
                    self.expect(&TokenKind::RBracket, "']' after list index");
                    base = Expr::Index {
                        base: Box::new(base),
                        index: Box::new(index),
                    };
                }
                _ => break,
            }
        }
        base
    }

    fn bracket_looks_like_index(&self) -> bool {
        if !matches!(self.kind(), TokenKind::LBracket) {
            return false;
        }
        let mut i = self.at + 1;
        let mut paren = 0i32;
        let mut brace = 0i32;
        let mut bracket = 1i32;
        while i < self.tokens.len() {
            match self.tokens[i].kind {
                TokenKind::LParen => paren += 1,
                TokenKind::RParen => paren -= 1,
                TokenKind::LBrace => brace += 1,
                TokenKind::RBrace => brace -= 1,
                TokenKind::LBracket => bracket += 1,
                TokenKind::RBracket => {
                    bracket -= 1;
                    if bracket == 0 {
                        return true;
                    }
                }
                TokenKind::Comma if paren == 0 && brace == 0 && bracket == 1 => {
                    return false;
                }
                _ => {}
            }
            i += 1;
        }
        false
    }

    fn parse_atom(&mut self) -> Expr {
        match self.kind().clone() {
            TokenKind::Number(n) => {
                self.bump();
                Expr::Num(n)
            }
            TokenKind::DurationSecs(s) => {
                self.bump();
                Expr::DurationSecs(s)
            }
            TokenKind::True => {
                self.bump();
                Expr::Bool(true)
            }
            TokenKind::False => {
                self.bump();
                Expr::Bool(false)
            }
            TokenKind::Str(parts) => {
                let span = self.span();
                self.bump();
                Expr::Str(self.build_str_segs(parts, span))
            }
            TokenKind::Ident(name) => {
                self.bump();
                Expr::Var(name)
            }
            TokenKind::UIdent(name) => {
                self.bump();
                Expr::Ctor(name)
            }
            TokenKind::Hash => {
                self.bump();
                let arg = self.parse_postfix();
                Expr::Apply {
                    func: Box::new(Expr::Var("len".to_string())),
                    arg: Box::new(arg),
                }
            }
            TokenKind::LParen => {
                self.bump();
                self.skip_newlines();
                let mut items = vec![self.parse_expr()];
                self.skip_newlines();
                while self.eat(&TokenKind::Comma) {
                    self.skip_newlines();
                    if matches!(self.kind(), TokenKind::RParen) {
                        break;
                    }
                    items.push(self.parse_expr());
                    self.skip_newlines();
                }
                self.expect(&TokenKind::RParen, "')'");
                if items.len() == 1 {
                    items.pop().unwrap()
                } else {
                    Expr::Tuple(items)
                }
            }
            TokenKind::LBracket => {
                self.bump();
                let mut items = Vec::new();
                self.skip_newlines();
                while !matches!(self.kind(), TokenKind::RBracket | TokenKind::Eof) {
                    items.push(self.parse_expr());
                    self.skip_separators();
                }
                self.expect(&TokenKind::RBracket, "']'");
                Expr::List(items)
            }
            TokenKind::LBrace => self.parse_brace(),
            _ => {
                self.error("expected an expression");
                self.bump();
                Expr::Bool(false)
            }
        }
    }

    /// `{ field = v, ... }` record literal, or `{ a1, a2 }` action block.
    fn parse_brace(&mut self) -> Expr {
        self.bump(); // '{'
        self.skip_newlines();
        let is_record = matches!(self.kind(), TokenKind::Ident(_))
            && matches!(self.peek_kind(1), TokenKind::Eq);
        if is_record {
            let mut fields = Vec::new();
            while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
                let name = self.expect_ident("field name");
                self.expect(&TokenKind::Eq, "'=' in record field");
                let value = self.parse_expr();
                fields.push((name, value));
                self.skip_separators();
            }
            self.expect(&TokenKind::RBrace, "'}'");
            Expr::Record(fields)
        } else {
            let mut items = Vec::new();
            while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
                items.push(self.parse_expr());
                self.skip_separators();
            }
            self.expect(&TokenKind::RBrace, "'}'");
            Expr::Block(items)
        }
    }

    fn build_str_segs(&mut self, parts: Vec<StrPart>, span: Span) -> Vec<StrSeg> {
        let mut segs = Vec::new();
        for part in parts {
            match part {
                StrPart::Lit(s) => segs.push(StrSeg::Lit(s)),
                StrPart::Hole(src) => segs.push(StrSeg::Expr(self.parse_hole(&src, span))),
            }
        }
        segs
    }

    fn parse_hole(&mut self, src: &str, span: Span) -> Expr {
        match lex(src) {
            Ok(toks) => {
                let mut sub = Parser::new(toks);
                sub.skip_layout();
                let e = sub.parse_expr();
                sub.skip_layout();
                if !matches!(sub.kind(), TokenKind::Eof) {
                    self.errors
                        .push(Diagnostic::new(span, "invalid interpolation expression"));
                }
                for d in sub.errors {
                    self.errors.push(Diagnostic::new(span, d.message));
                }
                e
            }
            Err(ds) => {
                for d in ds {
                    self.errors.push(Diagnostic::new(span, d.message));
                }
                Expr::Bool(false)
            }
        }
    }

    // ----- patterns -----

    fn parse_pattern(&mut self) -> Pattern {
        let left = self.parse_pattern_atom();
        if self.eat(&TokenKind::ColonColon) {
            Pattern::Cons(Box::new(left), Box::new(self.parse_pattern()))
        } else {
            left
        }
    }

    fn parse_pattern_atom(&mut self) -> Pattern {
        match self.kind().clone() {
            TokenKind::Underscore => {
                self.bump();
                Pattern::Wildcard
            }
            TokenKind::Number(n) => {
                self.bump();
                Pattern::Num(n)
            }
            TokenKind::DurationSecs(s) => {
                self.bump();
                Pattern::Dur(s)
            }
            TokenKind::True => {
                self.bump();
                Pattern::Bool(true)
            }
            TokenKind::False => {
                self.bump();
                Pattern::Bool(false)
            }
            TokenKind::Str(parts) => {
                self.bump();
                match parts.as_slice() {
                    [StrPart::Lit(s)] => Pattern::Str(s.clone()),
                    _ => {
                        self.error("string patterns cannot contain interpolation");
                        Pattern::Wildcard
                    }
                }
            }
            TokenKind::Ident(name) => {
                self.bump();
                Pattern::Var(name)
            }
            TokenKind::UIdent(name) => {
                self.bump();
                let mut args = Vec::new();
                if self.eat(&TokenKind::LParen) {
                    loop {
                        args.push(self.parse_pattern());
                        if !self.eat(&TokenKind::Comma) {
                            break;
                        }
                    }
                    self.expect(&TokenKind::RParen, "')'");
                }
                Pattern::Variant { name, args }
            }
            TokenKind::LParen => {
                self.bump();
                let mut items = vec![self.parse_pattern()];
                while self.eat(&TokenKind::Comma) {
                    items.push(self.parse_pattern());
                }
                self.expect(&TokenKind::RParen, "')'");
                if items.len() == 1 {
                    items.pop().unwrap()
                } else {
                    Pattern::Tuple(items)
                }
            }
            TokenKind::LBracket => {
                self.bump();
                let mut items = Vec::new();
                self.skip_newlines();
                while !matches!(self.kind(), TokenKind::RBracket | TokenKind::Eof) {
                    items.push(self.parse_pattern());
                    self.skip_separators();
                }
                self.expect(&TokenKind::RBracket, "']'");
                if items.is_empty() {
                    Pattern::Nil
                } else {
                    Pattern::List(items)
                }
            }
            TokenKind::LBrace => {
                self.bump();
                self.skip_newlines();
                let mut fields = Vec::new();
                let mut rest = false;
                while !matches!(self.kind(), TokenKind::RBrace | TokenKind::Eof) {
                    if matches!(self.kind(), TokenKind::Underscore) {
                        self.bump();
                        rest = true;
                        self.skip_separators();
                        continue;
                    }
                    let name = self.expect_ident("field name");
                    let sub = if self.eat(&TokenKind::Eq) {
                        Some(self.parse_pattern())
                    } else {
                        None
                    };
                    fields.push((name, sub));
                    self.skip_separators();
                }
                self.expect(&TokenKind::RBrace, "'}'");
                Pattern::Record { fields, rest }
            }
            _ => {
                self.error("expected a pattern");
                self.bump();
                Pattern::Wildcard
            }
        }
    }

    // ----- helpers -----

    fn skip_separators(&mut self) {
        while matches!(self.kind(), TokenKind::Comma | TokenKind::Newline) {
            self.bump();
        }
    }

    fn expect_ident(&mut self, what: &str) -> String {
        if let TokenKind::Ident(s) = self.kind().clone() {
            self.bump();
            s
        } else {
            self.error(format!("expected {what}"));
            String::new()
        }
    }

    fn expect_uident(&mut self, what: &str) -> String {
        if let TokenKind::UIdent(s) = self.kind().clone() {
            self.bump();
            s
        } else {
            self.error(format!("expected {what}"));
            String::new()
        }
    }
}
