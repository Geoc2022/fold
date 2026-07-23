//! VAPID-authenticated, RFC 8291 encrypted Web Push delivery.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use worker::*;

use crate::db::{self, PushSubscriptionRow};
use crate::push_crypto::{encrypt_payload, validate_vapid_key_pair, vapid_audience};

const PUSH_LIMIT: i64 = 100;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PushPayload<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub url: &'a str,
    pub tag: &'a str,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
struct VapidConfig {
    public_key: String,
    private_key: String,
    subject: String,
}

#[derive(Debug, Clone)]
pub struct PushResponse {
    pub status: u16,
    pub details: Option<String>,
}

fn env_string(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|v| v.to_string())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn vapid_config(env: &Env) -> Option<VapidConfig> {
    Some(VapidConfig {
        public_key: env_string(env, "VAPID_PUBLIC_KEY")?,
        private_key: env_string(env, "VAPID_PRIVATE_KEY")?,
        subject: env_string(env, "VAPID_SUBJECT")
            .unwrap_or_else(|| "mailto:fold@example.invalid".to_string()),
    })
}

pub fn public_key(env: &Env) -> Option<String> {
    env_string(env, "VAPID_PUBLIC_KEY")
}

pub async fn send_to_people(env: &Env, db: &D1Database, person_ids: &[String]) -> Result<()> {
    let id = crate::util::new_id();
    let payload = PushPayload {
        id: &id,
        title: "fold activity update",
        body: "Open fold to see what changed.",
        url: "/",
        tag: "fold-update",
        created_at: crate::util::now_ms(),
    };
    send_payload_to_people(env, db, person_ids, &payload).await
}

pub async fn send_payload_to_people(
    env: &Env,
    db: &D1Database,
    person_ids: &[String],
    payload: &PushPayload<'_>,
) -> Result<()> {
    let Some(cfg) = vapid_config(env) else {
        return Ok(());
    };
    let plaintext = serde_json::to_vec(payload)
        .map_err(|e| Error::RustError(format!("push payload encode failed: {e}")))?;
    let subs = db::push_subscriptions_for_people(db, person_ids, PUSH_LIMIT).await?;
    for sub in subs {
        match send_one(&cfg, &sub, &plaintext).await {
            Ok(response) => {
                if matches!(response.status, 404 | 410) {
                    db::delete_push_endpoint(db, &sub.endpoint).await?;
                }
            }
            Err(e) => console_warn!(
                "push delivery failed for subscription {} ({}): {e}",
                sub.id,
                sub.endpoint
            ),
        }
    }
    Ok(())
}

pub async fn send_payload_to_subscription(
    env: &Env,
    sub: &PushSubscriptionRow,
    payload: &PushPayload<'_>,
) -> Result<Option<PushResponse>> {
    let Some(cfg) = vapid_config(env) else {
        return Ok(None);
    };
    let plaintext = serde_json::to_vec(payload)
        .map_err(|e| Error::RustError(format!("push payload encode failed: {e}")))?;
    send_one(&cfg, sub, &plaintext).await.map(Some)
}

async fn send_one(
    cfg: &VapidConfig,
    sub: &PushSubscriptionRow,
    plaintext: &[u8],
) -> Result<PushResponse> {
    let jwt = vapid_jwt(cfg, &sub.endpoint)?;
    let encrypted = encrypt_payload(&sub.p256dh, &sub.auth, plaintext)
        .map_err(|e| Error::RustError(format!("push encryption failed: {e}")))?;
    let headers = Headers::new();
    headers.set("TTL", "60")?;
    headers.set("Content-Encoding", encrypted.content_encoding)?;
    headers.set("Content-Type", "application/octet-stream")?;
    headers.set(
        "Authorization",
        &format!("vapid t={jwt}, k={}", cfg.public_key),
    )?;

    let mut init = RequestInit::new();
    let body = worker::js_sys::Uint8Array::from(encrypted.body.as_slice());
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.into()));
    let req = Request::new_with_init(&sub.endpoint, &init)?;
    let mut resp = Fetch::Request(req).send().await?;
    let status = resp.status_code();
    let origin = endpoint_origin(&sub.endpoint)?;
    let details = if (200..300).contains(&status) {
        None
    } else {
        let challenge = resp.headers().get("WWW-Authenticate")?.unwrap_or_default();
        let body = resp.text().await.unwrap_or_default();
        Some(response_details(&challenge, &body))
    };
    console_log!(
        "[fold:push] delivery subscription={} origin={} status={} details={}",
        sub.id,
        origin,
        status,
        details.as_deref().unwrap_or("none")
    );
    Ok(PushResponse { status, details })
}

fn vapid_jwt(cfg: &VapidConfig, endpoint: &str) -> Result<String> {
    validate_vapid_key_pair(&cfg.public_key, &cfg.private_key)
        .map_err(|error| Error::RustError(error.to_string()))?;
    let aud = endpoint_origin(endpoint)?;
    let exp = (Date::now().as_millis() / 1000) as i64 + 12 * 60 * 60;
    let header = serde_json::json!({ "typ": "JWT", "alg": "ES256" });
    let payload = serde_json::json!({
        "aud": aud,
        "exp": exp,
        "sub": cfg.subject,
    });
    let signing_input = format!("{}.{}", b64_json(&header)?, b64_json(&payload)?,);

    let key_bytes = URL_SAFE_NO_PAD
        .decode(cfg.private_key.as_bytes())
        .map_err(|e| Error::RustError(format!("invalid VAPID_PRIVATE_KEY: {e}")))?;
    let signing_key = SigningKey::from_slice(&key_bytes)
        .map_err(|_| Error::RustError("invalid VAPID_PRIVATE_KEY".into()))?;
    let sig: Signature = signing_key.sign(signing_input.as_bytes());
    Ok(format!(
        "{}.{}",
        signing_input,
        URL_SAFE_NO_PAD.encode(sig.to_bytes())
    ))
}

fn response_details(challenge: &str, body: &str) -> String {
    let combined = match (challenge.trim(), body.trim()) {
        ("", "") => "push service returned no error details".to_string(),
        ("", body) => body.to_string(),
        (challenge, "") => format!("WWW-Authenticate: {challenge}"),
        (challenge, body) => format!("WWW-Authenticate: {challenge}; body: {body}"),
    };
    combined.chars().take(500).collect()
}

fn b64_json(value: &serde_json::Value) -> Result<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| Error::RustError(format!("json encode failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn endpoint_origin(endpoint: &str) -> Result<String> {
    vapid_audience(endpoint).map_err(|error| Error::RustError(error.to_string()))
}
