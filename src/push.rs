//! Minimal Web Push delivery.
//!
//! We send no payload. That means no Web Push content encryption is needed; the
//! browser service worker receives a wake-up event and shows a generic
//! notification, then the app syncs on open.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use worker::*;

use crate::db::{self, PushSubscriptionRow};

const PUSH_LIMIT: i64 = 100;

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
    let Some(cfg) = vapid_config(env) else {
        return Ok(());
    };
    let subs = db::push_subscriptions_for_people(db, person_ids, PUSH_LIMIT).await?;
    for sub in subs {
        match send_one(&cfg, &sub).await {
            Ok(should_delete) => {
                if should_delete {
                    db::delete_push_endpoint(db, &sub.endpoint).await?;
                }
            }
            Err(e) => console_warn!("push delivery failed for {}: {e}", sub.endpoint),
        }
    }
    Ok(())
}

async fn send_one(cfg: &VapidConfig, sub: &PushSubscriptionRow) -> Result<bool> {
    let jwt = vapid_jwt(cfg, &sub.endpoint)?;
    let headers = Headers::new();
    headers.set("TTL", "60")?;
    headers.set(
        "Authorization",
        &format!("vapid t={jwt}, k={}", cfg.public_key),
    )?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers);
    let req = Request::new_with_init(&sub.endpoint, &init)?;
    let resp = Fetch::Request(req).send().await?;
    // 404/410 indicate stale browser subscriptions and should be pruned.
    Ok(resp.status_code() == 404 || resp.status_code() == 410)
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
