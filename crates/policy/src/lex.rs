use crate::diag::{Diagnostic, Span};

/// A part of an interpolated string literal. `"hi {name}!"` lexes to
/// `[Lit("hi "), Hole("name"), Lit("!")]`. Holes carry the raw source of the
/// embedded expression, which the parser re-parses.
#[derive(Debug, Clone, PartialEq)]
pub enum StrPart {
    Lit(String),
    Hole(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum TokenKind {
    /// Lowercase-initial identifier (value / field name).
    Ident(String),
    /// Uppercase-initial identifier (type / variant / trait name).
    UIdent(String),
    /// Interpolated string literal.
    Str(Vec<StrPart>),
    Number(f64),
    DurationSecs(i64),
    Hash,
    Dot,
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Colon,
    ColonColon,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Lt,
    Lte,
    Gt,
    Gte,
    EqEq,
    Neq,
    Eq,
    FatArrow,
    Arrow,
    Pipe,
    And,
    Or,
    Not,
    Xor,
    True,
    False,
    Fun,
    Match,
    With,
    If,
    Then,
    Else,
    Before,
    By,
    Type,
    Trait,
    Impl,
    Underscore,
    /// `(** ... *)` documentation comment (attached to following declaration).
    DocComment(String),
    Newline,
    Indent,
    Dedent,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

/// Off-side-rule lexer (indentation from Python; token set from ML/Rust).
///
/// Emits `Newline`/`Indent`/`Dedent` so the parser can handle multi-statement
/// programs and indented `match` arms. Layout tokens are suppressed inside
/// `()`, `[]`, and `{}` (implicit line continuation, as in Python).
pub fn lex(input: &str) -> Result<Vec<Token>, Vec<Diagnostic>> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    // `()` suppress newlines (implicit continuation). Any open bracket
    // suppresses Indent/Dedent. Inside `[]`/`{}` newlines act as separators.
    let mut paren_depth: i32 = 0;
    let mut layout_depth: i32 = 0;
    let mut indent_stack: Vec<usize> = vec![0];
    let mut at_line_start = true;
    let mut line_has_content = false;

    while i < bytes.len() {
        if at_line_start && paren_depth == 0 {
            let mut col = 0;
            let mut j = i;
            while j < bytes.len() {
                match bytes[j] as char {
                    ' ' => {
                        col += 1;
                        j += 1;
                    }
                    '\t' => {
                        col += 1;
                        j += 1;
                    }
                    _ => break,
                }
            }
            // Blank line: skip.
            if j >= bytes.len() || bytes[j] as char == '\n' || bytes[j] as char == '\r' {
                i = j;
                if i < bytes.len() {
                    i += 1;
                }
                continue;
            }
            // Skip layout reconciliation if the line opens with a comment.
            let is_comment =
                bytes[j] as char == '(' && j + 1 < bytes.len() && bytes[j + 1] as char == '*';
            if !is_comment && layout_depth == 0 {
                let top = *indent_stack.last().unwrap();
                if col > top {
                    indent_stack.push(col);
                    out.push(Token {
                        kind: TokenKind::Indent,
                        span: Span::new(i, j),
                    });
                } else if col < top {
                    while *indent_stack.last().unwrap() > col {
                        indent_stack.pop();
                        out.push(Token {
                            kind: TokenKind::Dedent,
                            span: Span::new(j, j),
                        });
                    }
                    if *indent_stack.last().unwrap() != col {
                        errors.push(Diagnostic::new(Span::new(i, j), "inconsistent indentation"));
                    }
                }
            }
            i = j;
            at_line_start = false;
        }

        let ch = bytes[i] as char;

        // Comments `(* ... *)` (nestable) and doc comments `(** ... *)`.
        if ch == '(' && i + 1 < bytes.len() && bytes[i + 1] as char == '*' {
            let start = i;
            let is_doc = i + 2 < bytes.len()
                && bytes[i + 2] as char == '*'
                && !(i + 3 < bytes.len() && bytes[i + 3] as char == ')');
            i += 2;
            if is_doc {
                i += 1; // skip the third '*' of "(**"
            }
            let mut depth = 1;
            let text_start = i;
            let mut text_end = i;
            while i < bytes.len() && depth > 0 {
                if i + 1 < bytes.len() && bytes[i] as char == '(' && bytes[i + 1] as char == '*' {
                    depth += 1;
                    i += 2;
                } else if i + 1 < bytes.len()
                    && bytes[i] as char == '*'
                    && bytes[i + 1] as char == ')'
                {
                    depth -= 1;
                    if depth == 0 {
                        text_end = i;
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth > 0 {
                errors.push(Diagnostic::new(Span::new(start, i), "unterminated comment"));
                continue;
            }
            if is_doc {
                // Strip the leading '*' of "(**" already consumed; text starts after it.
                let raw = &input[text_start..text_end];
                let text = raw.trim().to_string();
                out.push(Token {
                    kind: TokenKind::DocComment(text),
                    span: Span::new(start, i),
                });
                line_has_content = true;
            }
            continue;
        }

        if ch == '\n' || ch == '\r' {
            i += 1;
            if paren_depth == 0 {
                if line_has_content {
                    out.push(Token {
                        kind: TokenKind::Newline,
                        span: Span::new(i - 1, i),
                    });
                    line_has_content = false;
                }
                at_line_start = true;
            }
            continue;
        }

        if ch == ' ' || ch == '\t' {
            i += 1;
            continue;
        }

        let start = i;
        let tok = match ch {
            '#' => {
                i += 1;
                TokenKind::Hash
            }
            '.' => {
                i += 1;
                TokenKind::Dot
            }
            '(' => {
                i += 1;
                paren_depth += 1;
                layout_depth += 1;
                TokenKind::LParen
            }
            ')' => {
                i += 1;
                paren_depth = (paren_depth - 1).max(0);
                layout_depth = (layout_depth - 1).max(0);
                TokenKind::RParen
            }
            '[' => {
                i += 1;
                layout_depth += 1;
                TokenKind::LBracket
            }
            ']' => {
                i += 1;
                layout_depth = (layout_depth - 1).max(0);
                TokenKind::RBracket
            }
            '{' => {
                i += 1;
                layout_depth += 1;
                TokenKind::LBrace
            }
            '}' => {
                i += 1;
                layout_depth = (layout_depth - 1).max(0);
                TokenKind::RBrace
            }
            '|' => {
                i += 1;
                TokenKind::Pipe
            }
            ':' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == ':' {
                    i += 2;
                    TokenKind::ColonColon
                } else {
                    i += 1;
                    TokenKind::Colon
                }
            }
            ',' => {
                i += 1;
                TokenKind::Comma
            }
            '+' => {
                i += 1;
                TokenKind::Plus
            }
            '-' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '>' {
                    i += 2;
                    TokenKind::Arrow
                } else {
                    i += 1;
                    TokenKind::Minus
                }
            }
            '*' => {
                i += 1;
                TokenKind::Star
            }
            '/' => {
                i += 1;
                TokenKind::Slash
            }
            '%' => {
                i += 1;
                TokenKind::Percent
            }
            '<' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
                    i += 2;
                    TokenKind::Lte
                } else {
                    i += 1;
                    TokenKind::Lt
                }
            }
            '>' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
                    i += 2;
                    TokenKind::Gte
                } else {
                    i += 1;
                    TokenKind::Gt
                }
            }
            '=' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '>' {
                    i += 2;
                    TokenKind::FatArrow
                } else if i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
                    i += 2;
                    TokenKind::EqEq
                } else {
                    i += 1;
                    TokenKind::Eq
                }
            }
            '"' => match scan_string(input, bytes, i) {
                Ok((parts, next)) => {
                    i = next;
                    TokenKind::Str(parts)
                }
                Err((span, msg)) => {
                    errors.push(Diagnostic::new(span, msg));
                    i = span.end.max(start + 1);
                    continue;
                }
            },
            '!' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
                    i += 2;
                    TokenKind::Neq
                } else {
                    errors.push(Diagnostic::new(
                        Span::new(start, start + 1),
                        "expected '!='",
                    ));
                    i += 1;
                    continue;
                }
            }
            c if c.is_ascii_digit() => match scan_number(input, bytes, i) {
                Ok((kind, next)) => {
                    i = next;
                    kind
                }
                Err((span, msg)) => {
                    errors.push(Diagnostic::new(span, msg));
                    i = span.end;
                    continue;
                }
            },
            c if c.is_ascii_alphabetic() || c == '_' => {
                let mut end = i + 1;
                while end < bytes.len() {
                    let ch = bytes[end] as char;
                    if ch.is_ascii_alphanumeric() || ch == '_' {
                        end += 1;
                    } else {
                        break;
                    }
                }
                let s = &input[i..end];
                i = end;
                match s {
                    "and" => TokenKind::And,
                    "or" => TokenKind::Or,
                    "not" => TokenKind::Not,
                    "xor" => TokenKind::Xor,
                    "true" => TokenKind::True,
                    "false" => TokenKind::False,
                    "fun" => TokenKind::Fun,
                    "match" => TokenKind::Match,
                    "with" => TokenKind::With,
                    "if" => TokenKind::If,
                    "then" => TokenKind::Then,
                    "else" => TokenKind::Else,
                    "before" => TokenKind::Before,
                    "by" => TokenKind::By,
                    "type" => TokenKind::Type,
                    "trait" => TokenKind::Trait,
                    "impl" => TokenKind::Impl,
                    "_" => TokenKind::Underscore,
                    _ if c.is_ascii_uppercase() => TokenKind::UIdent(s.to_string()),
                    _ => TokenKind::Ident(s.to_string()),
                }
            }
            _ => {
                errors.push(Diagnostic::new(
                    Span::new(start, start + 1),
                    format!("unexpected character '{ch}'"),
                ));
                i += 1;
                continue;
            }
        };
        line_has_content = true;
        out.push(Token {
            kind: tok,
            span: Span::new(start, i),
        });
    }

    if line_has_content {
        out.push(Token {
            kind: TokenKind::Newline,
            span: Span::new(input.len(), input.len()),
        });
    }
    while *indent_stack.last().unwrap() > 0 {
        indent_stack.pop();
        out.push(Token {
            kind: TokenKind::Dedent,
            span: Span::new(input.len(), input.len()),
        });
    }
    out.push(Token {
        kind: TokenKind::Eof,
        span: Span::new(input.len(), input.len()),
    });
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

/// Scan a `"..."` string with `{expr}` interpolation holes. `{{` / `}}` escape
/// literal braces.
fn scan_string(
    input: &str,
    bytes: &[u8],
    start: usize,
) -> Result<(Vec<StrPart>, usize), (Span, String)> {
    let mut i = start + 1;
    let mut parts: Vec<StrPart> = Vec::new();
    let mut lit = String::new();
    let mut closed = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '"' {
            i += 1;
            closed = true;
            break;
        }
        if c == '\\' {
            if i + 1 >= bytes.len() {
                break;
            }
            let e = bytes[i + 1] as char;
            match e {
                '"' => lit.push('"'),
                '\\' => lit.push('\\'),
                'n' => lit.push('\n'),
                't' => lit.push('\t'),
                _ => lit.push(e),
            }
            i += 2;
            continue;
        }
        if c == '{' {
            if i + 1 < bytes.len() && bytes[i + 1] as char == '{' {
                lit.push('{');
                i += 2;
                continue;
            }
            if !lit.is_empty() {
                parts.push(StrPart::Lit(std::mem::take(&mut lit)));
            }
            i += 1;
            let hole_start = i;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                let d = bytes[i] as char;
                if d == '{' {
                    depth += 1;
                    i += 1;
                } else if d == '}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    i += 1;
                } else if d == '"' {
                    return Err((
                        Span::new(start, i),
                        "unterminated interpolation hole".to_string(),
                    ));
                } else {
                    i += 1;
                }
            }
            if depth > 0 {
                return Err((
                    Span::new(start, i),
                    "unterminated interpolation hole".to_string(),
                ));
            }
            let expr = input[hole_start..i].trim().to_string();
            i += 1; // consume '}'
            if expr.is_empty() {
                return Err((
                    Span::new(hole_start, i),
                    "empty interpolation hole".to_string(),
                ));
            }
            parts.push(StrPart::Hole(expr));
            continue;
        }
        if c == '}' {
            if i + 1 < bytes.len() && bytes[i + 1] as char == '}' {
                lit.push('}');
                i += 2;
                continue;
            }
            lit.push('}');
            i += 1;
            continue;
        }
        lit.push(c);
        i += 1;
    }
    if !closed {
        return Err((
            Span::new(start, i),
            "unterminated string literal".to_string(),
        ));
    }
    if !lit.is_empty() {
        parts.push(StrPart::Lit(lit));
    }
    if parts.is_empty() {
        parts.push(StrPart::Lit(String::new()));
    }
    Ok((parts, i))
}

/// Scan a numeric literal, possibly a (compound) duration like `1m2s`.
fn scan_number(
    input: &str,
    bytes: &[u8],
    start: usize,
) -> Result<(TokenKind, usize), (Span, String)> {
    let mut end = start + 1;
    while end < bytes.len() && (bytes[end] as char).is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] as char == '.' {
        end += 1;
        while end < bytes.len() && (bytes[end] as char).is_ascii_digit() {
            end += 1;
        }
    }
    let num = match input[start..end].parse::<f64>() {
        Ok(v) => v,
        Err(_) => return Err((Span::new(start, end), "invalid number literal".to_string())),
    };
    let mut unit_end = end;
    while unit_end < bytes.len() && (bytes[unit_end] as char).is_ascii_alphabetic() {
        unit_end += 1;
    }
    if unit_end == end {
        return Ok((TokenKind::Number(num), end));
    }
    let unit = &input[end..unit_end];
    let mut total = match duration_secs(num, unit) {
        Some(secs) => secs,
        None => {
            return Err((
                Span::new(end, unit_end),
                format!("unknown duration unit '{unit}'"),
            ))
        }
    };
    let mut cursor = unit_end;
    while cursor < bytes.len() && (bytes[cursor] as char).is_ascii_digit() {
        let mut num_end = cursor + 1;
        while num_end < bytes.len() && (bytes[num_end] as char).is_ascii_digit() {
            num_end += 1;
        }
        if num_end < bytes.len() && bytes[num_end] as char == '.' {
            num_end += 1;
            while num_end < bytes.len() && (bytes[num_end] as char).is_ascii_digit() {
                num_end += 1;
            }
        }
        let mut u_end = num_end;
        while u_end < bytes.len() && (bytes[u_end] as char).is_ascii_alphabetic() {
            u_end += 1;
        }
        if u_end == num_end {
            return Err((
                Span::new(num_end, num_end),
                "expected duration unit in compound duration".to_string(),
            ));
        }
        let part_num = match input[cursor..num_end].parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                return Err((
                    Span::new(cursor, num_end),
                    "invalid number literal".to_string(),
                ))
            }
        };
        let part_unit = &input[num_end..u_end];
        match duration_secs(part_num, part_unit) {
            Some(secs) => total += secs,
            None => {
                return Err((
                    Span::new(num_end, u_end),
                    format!("unknown duration unit '{part_unit}'"),
                ))
            }
        }
        cursor = u_end;
    }
    Ok((TokenKind::DurationSecs(total), cursor))
}

pub fn duration_secs(num: f64, unit: &str) -> Option<i64> {
    let factor = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
        _ => return None,
    };
    Some((num * factor).round() as i64)
}
