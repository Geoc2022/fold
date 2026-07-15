use crate::diag::{Diagnostic, Span};

#[derive(Debug, Clone, PartialEq)]
pub enum TokenKind {
    Ident(String),
    Str(String),
    Number(f64),
    DurationSecs(i64),
    Hash,
    Dot,
    LParen,
    RParen,
    Colon,
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
    LBrace,
    RBrace,
    Pipe,
    Semi,
    And,
    Or,
    Not,
    Xor,
    True,
    False,
    Fun,
    Match,
    Type,
    Underscore,
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
/// programs and indented `match` arms. Newlines are suppressed inside
/// parentheses (implicit line continuation, as in Python).
pub fn lex(input: &str) -> Result<Vec<Token>, Vec<Diagnostic>> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut paren_depth: i32 = 0;
    let mut brace_depth: i32 = 0;
    let mut indent_stack: Vec<usize> = vec![0];
    // Are we at the beginning of a fresh logical line (need to measure indent)?
    let mut at_line_start = true;
    // Did the current logical line emit any real token yet?
    let mut line_has_content = false;

    while i < bytes.len() {
        // Handle line starts. Indentation (Indent/Dedent) is only significant at
        // the top level; inside braces/parens we just consume leading whitespace.
        if at_line_start && paren_depth == 0 {
            let mut col = 0;
            let mut j = i;
            while j < bytes.len() {
                match bytes[j] as char {
                    ' ' | '\t' => {
                        col += 1;
                        j += 1;
                    }
                    _ => break,
                }
            }
            // Blank line (only whitespace then newline or EOF): skip it.
            if j >= bytes.len() || bytes[j] as char == '\n' || bytes[j] as char == '\r' {
                i = j;
                if i < bytes.len() {
                    i += 1; // consume the newline
                }
                continue;
            }
            if brace_depth == 0 {
                // Reconcile indentation.
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

        // OCaml-style comments `(* ... *)`, nestable.
        if ch == '(' && i + 1 < bytes.len() && bytes[i + 1] as char == '*' {
            let start = i;
            i += 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if i + 1 < bytes.len() && bytes[i] as char == '(' && bytes[i + 1] as char == '*' {
                    depth += 1;
                    i += 2;
                } else if i + 1 < bytes.len() && bytes[i] as char == '*' && bytes[i + 1] as char == ')' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth > 0 {
                errors.push(Diagnostic::new(Span::new(start, i), "unterminated comment"));
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
                TokenKind::LParen
            }
            ')' => {
                i += 1;
                paren_depth = (paren_depth - 1).max(0);
                TokenKind::RParen
            }
            '{' => {
                i += 1;
                brace_depth += 1;
                TokenKind::LBrace
            }
            '}' => {
                i += 1;
                brace_depth = (brace_depth - 1).max(0);
                TokenKind::RBrace
            }
            '|' => {
                i += 1;
                TokenKind::Pipe
            }
            ';' => {
                i += 1;
                TokenKind::Semi
            }
            ':' => {
                i += 1;
                TokenKind::Colon
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
            '"' => {
                i += 1;
                let mut s = String::new();
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
                            '"' => s.push('"'),
                            '\\' => s.push('\\'),
                            'n' => s.push('\n'),
                            't' => s.push('\t'),
                            _ => s.push(e),
                        }
                        i += 2;
                        continue;
                    }
                    s.push(c);
                    i += 1;
                }
                if !closed {
                    errors.push(Diagnostic::new(
                        Span::new(start, i),
                        "unterminated string literal",
                    ));
                    continue;
                }
                TokenKind::Str(s)
            }
            '!' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
                    i += 2;
                    TokenKind::Neq
                } else {
                    errors.push(Diagnostic::new(Span::new(start, start + 1), "expected '!='"));
                    i += 1;
                    continue;
                }
            }
            c if c.is_ascii_digit() => {
                match scan_number(input, bytes, i) {
                    Ok((kind, next)) => {
                        i = next;
                        kind
                    }
                    Err((span, msg)) => {
                        errors.push(Diagnostic::new(span, msg));
                        i = span.end;
                        continue;
                    }
                }
            }
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
                    "type" => TokenKind::Type,
                    "_" => TokenKind::Underscore,
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

    // Trailing newline for the last logical line.
    if line_has_content {
        out.push(Token {
            kind: TokenKind::Newline,
            span: Span::new(input.len(), input.len()),
        });
    }
    // Close out any open indentation levels.
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
    // Optional unit -> duration.
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
    // Compound durations with no separating whitespace, e.g. `1m2s`, `1h30m`.
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
            Err(_) => return Err((Span::new(cursor, num_end), "invalid number literal".to_string())),
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
