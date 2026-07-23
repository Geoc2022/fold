//! VAPID-authenticated, RFC 8291 encrypted Web Push delivery.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use worker::*;

use crate::db::{self, PushSubscriptionRow};
use crate::push_crypto::encrypt_payload;

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

fn env_string(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|v| v.to_string())
        .filter(|v| !v.trim().is_empty())
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
            Ok(status) => {
                if matches!(status, 404 | 410) {
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
) -> Result<Option<u16>> {
    let Some(cfg) = vapid_config(env) else {
        return Ok(None);
    };
    let plaintext = serde_json::to_vec(payload)
        .map_err(|e| Error::RustError(format!("push payload encode failed: {e}")))?;
    send_one(&cfg, sub, &plaintext).await.map(Some)
}

async fn send_one(cfg: &VapidConfig, sub: &PushSubscriptionRow, plaintext: &[u8]) -> Result<u16> {
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
    let resp = Fetch::Request(req).send().await?;
    Ok(resp.status_code())
}

fn vapid_jwt(cfg: &VapidConfig, endpoint: &str) -> Result<String> {
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

fn b64_json(value: &serde_json::Value) -> Result<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| Error::RustError(format!("json encode failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn endpoint_origin(endpoint: &str) -> Result<String> {
    let url = Url::parse(endpoint)?;
    let protocol = url.scheme();
    let host = url
        .host_str()
        .ok_or_else(|| Error::RustError("push endpoint missing host".into()))?;
    Ok(match url.port() {
        Some(port) => format!("{protocol}//{host}:{port}"),
        None => format!("{protocol}//{host}"),
    })
}
