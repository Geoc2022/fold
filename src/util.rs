//! Small runtime helpers (Worker-only).

use serde::Serialize;
use worker::*;

/// Current time as unix epoch milliseconds.
pub fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// Generate a random 128-bit id as a 32-char lowercase hex string.
pub fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("rng unavailable");
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

const PALETTE: &[&str] = &[
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6",
    "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e",
];

/// Pick a random color from the node palette.
pub fn random_color() -> String {
    let mut b = [0u8; 1];
    getrandom::getrandom(&mut b).expect("rng unavailable");
    PALETTE[(b[0] as usize) % PALETTE.len()].to_string()
}

/// Extract the caller's person id from the `X-Person-Id` header, if present.
pub fn person_id(req: &Request) -> Option<String> {
    req.headers()
        .get("X-Person-Id")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

/// JSON response with an explicit status code.
pub fn json_status<T: Serialize>(value: &T, status: u16) -> Result<Response> {
    Ok(Response::from_json(value)?.with_status(status))
}

/// Standard JSON error body with a status code.
pub fn err_json(message: &str, status: u16) -> Result<Response> {
    let body = serde_json::json!({ "error": message });
    Ok(Response::from_json(&body)?.with_status(status))
}
