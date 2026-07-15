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
    FatArrow,
    And,
    Or,
    Not,
    Xor,
    True,
    False,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

pub fn lex(input: &str) -> Result<Vec<Token>, Vec<Diagnostic>> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch.is_ascii_whitespace() {
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
                TokenKind::LParen
            }
            ')' => {
                i += 1;
                TokenKind::RParen
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
                i += 1;
                TokenKind::Minus
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
                    errors.push(Diagnostic::new(
                        Span::new(start, start + 1),
                        "expected '=>' or '=='",
                    ));
                    i += 1;
                    continue;
                }
            }
            '"' => {
                i += 1;
                let mut out = String::new();
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
                            '"' => out.push('"'),
                            '\\' => out.push('\\'),
                            'n' => out.push('\n'),
                            't' => out.push('\t'),
                            _ => out.push(e),
                        }
                        i += 2;
                        continue;
                    }
                    out.push(c);
                    i += 1;
                }
                if !closed {
                    errors.push(Diagnostic::new(
                        Span::new(start, i),
                        "unterminated string literal",
                    ));
                    continue;
                }
                TokenKind::Str(out)
            }
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
            c if c.is_ascii_digit() => {
                let mut end = i + 1;
                while end < bytes.len() && (bytes[end] as char).is_ascii_digit() {
                    end += 1;
                }
                if end < bytes.len() && bytes[end] as char == '.' {
                    end += 1;
                    while end < bytes.len() && (bytes[end] as char).is_ascii_digit() {
                        end += 1;
                    }
                }
                let number_str = &input[i..end];
                let num = match number_str.parse::<f64>() {
                    Ok(v) => v,
                    Err(_) => {
                        errors.push(Diagnostic::new(
                            Span::new(start, end),
                            "invalid number literal",
                        ));
                        i = end;
                        continue;
                    }
                };
                let mut unit_end = end;
                while unit_end < bytes.len() && (bytes[unit_end] as char).is_ascii_alphabetic() {
                    unit_end += 1;
                }
                if unit_end > end {
                    let unit = &input[end..unit_end];
                    match duration_secs(num, unit) {
                        Some(secs) => {
                            i = unit_end;
                            TokenKind::DurationSecs(secs)
                        }
                        None => {
                            errors.push(Diagnostic::new(
                                Span::new(end, unit_end),
                                format!("unknown duration unit '{unit}'"),
                            ));
                            i = unit_end;
                            continue;
                        }
                    }
                } else {
                    i = end;
                    TokenKind::Number(num)
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
        out.push(Token {
            kind: tok,
            span: Span::new(start, i),
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

pub fn duration_secs(num: f64, unit: &str) -> Option<i64> {
    let factor = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
        _ => return None,
    };
    Some((num * factor).round() as i64)
}
