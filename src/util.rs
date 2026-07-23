//! Small runtime helpers (Worker-only).

use serde::Serialize;
use sha2::{Digest, Sha256};
use worker::*;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

pub const SESSION_COOKIE: &str = "fold_session";
pub const SESSION_TTL_MS: i64 = 365 * 24 * 60 * 60 * 1000;

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

/// Generate a 4-letter share code (A-Z). Collisions are checked by the API.
pub fn new_code() -> String {
    let mut bytes = [0u8; 4];
    getrandom::getrandom(&mut bytes).expect("rng unavailable");
    bytes
        .into_iter()
        .map(|b| (b'A' + (b % 26)) as char)
        .collect()
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

pub fn new_session_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("rng unavailable");
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = session_token_hash(&token);
    (token, hash)
}

pub fn session_token_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

pub fn session_token(req: &Request) -> Option<String> {
    let cookies = req.headers().get("Cookie").ok().flatten()?;
    cookies.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == SESSION_COOKIE && !value.is_empty()).then(|| value.to_string())
    })
}

pub fn session_cookie(req: &Request, token: &str) -> Result<String> {
    let secure = if req.url()?.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    Ok(format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        SESSION_TTL_MS / 1000,
        secure
    ))
}

pub fn expired_session_cookie(req: &Request) -> Result<String> {
    let secure = if req.url()?.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    Ok(format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"
    ))
}

pub fn request_is_same_origin(req: &Request) -> Result<bool> {
    if matches!(req.method(), Method::Get | Method::Head | Method::Options) {
        return Ok(true);
    }
    let Some(origin) = req.headers().get("Origin")? else {
        return Ok(false);
    };
    Ok(origin == req.url()?.origin().ascii_serialization())
}

/// Whether a nominally safe request may perform incidental writes such as a
/// presence heartbeat. Cross-site top-level GETs can carry SameSite=Lax
/// cookies, so they must remain read-only.
pub fn request_has_same_origin_context(req: &Request) -> Result<bool> {
    if let Some(origin) = req.headers().get("Origin")? {
        return Ok(origin == req.url()?.origin().ascii_serialization());
    }
    Ok(req.headers().get("Sec-Fetch-Site")?.as_deref() == Some("same-origin"))
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
