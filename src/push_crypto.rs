//! RFC 8291 Web Push payload encryption using the `aes128gcm` content coding.

use std::{error::Error, fmt};

use aes_gcm::{aead::Aead, Aes128Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hkdf::Hkdf;
use p256::{ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use sha2::Sha256;

pub const CONTENT_ENCODING: &str = "aes128gcm";
pub const MAX_PLAINTEXT_LEN: usize = 3993;

const AUTH_SECRET_LEN: usize = 16;
const PUBLIC_KEY_LEN: usize = 65;
const SALT_LEN: usize = 16;
const RECORD_SIZE: u32 = 4096;
const HEADER_LEN: usize = SALT_LEN + 4 + 1 + PUBLIC_KEY_LEN;

/// An encrypted HTTP request body and the metadata needed to send it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedPush {
    pub body: Vec<u8>,
    pub content_encoding: &'static str,
    /// The base64url application-server ECDH key embedded in `body`'s keyid.
    pub ephemeral_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushCryptoError {
    InvalidP256dhBase64,
    InvalidP256dhLength,
    InvalidP256dhKey,
    InvalidAuthBase64,
    InvalidAuthLength,
    PayloadTooLarge { len: usize, max: usize },
    Randomness(String),
    KeyDerivation,
    Encryption,
}

impl fmt::Display for PushCryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidP256dhBase64 => write!(f, "p256dh is not canonical base64url"),
            Self::InvalidP256dhLength => {
                write!(f, "p256dh must be a 65-byte uncompressed P-256 key")
            }
            Self::InvalidP256dhKey => write!(f, "p256dh is not a valid P-256 public key"),
            Self::InvalidAuthBase64 => write!(f, "auth is not canonical base64url"),
            Self::InvalidAuthLength => write!(f, "auth must decode to exactly 16 bytes"),
            Self::PayloadTooLarge { len, max } => {
                write!(f, "push payload is {len} bytes; maximum is {max}")
            }
            Self::Randomness(message) => write!(f, "secure randomness failed: {message}"),
            Self::KeyDerivation => write!(f, "Web Push key derivation failed"),
            Self::Encryption => write!(f, "Web Push payload encryption failed"),
        }
    }
}

impl Error for PushCryptoError {}

/// Encrypts `plaintext` for a Web Push subscription.
///
/// Both subscription values must be unpadded, canonical base64url. `p256dh`
/// must contain a valid uncompressed P-256 point and `auth` exactly 16 bytes.
pub fn encrypt_payload(
    subscriber_p256dh: &str,
    subscriber_auth: &str,
    plaintext: &[u8],
) -> Result<EncryptedPush, PushCryptoError> {
    let subscriber_public = decode_subscriber_public_key(subscriber_p256dh)?;
    let auth_secret = decode_auth_secret(subscriber_auth)?;

    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(PushCryptoError::PayloadTooLarge {
            len: plaintext.len(),
            max: MAX_PLAINTEXT_LEN,
        });
    }

    let sender_private = random_secret_key()?;
    let mut salt = [0_u8; SALT_LEN];
    getrandom::getrandom(&mut salt)
        .map_err(|error| PushCryptoError::Randomness(error.to_string()))?;

    encrypt_with_material(
        &subscriber_public,
        &auth_secret,
        plaintext,
        &sender_private,
        salt,
    )
}

pub fn validate_subscription(p256dh: &str, auth: &str) -> Result<(), PushCryptoError> {
    decode_subscriber_public_key(p256dh)?;
    decode_auth_secret(auth)?;
    Ok(())
}

fn decode_canonical_base64url(
    encoded: &str,
    error: PushCryptoError,
) -> Result<Vec<u8>, PushCryptoError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| error.clone())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        return Err(error);
    }
    Ok(decoded)
}

fn decode_subscriber_public_key(encoded: &str) -> Result<PublicKey, PushCryptoError> {
    let bytes = decode_canonical_base64url(encoded, PushCryptoError::InvalidP256dhBase64)?;
    if bytes.len() != PUBLIC_KEY_LEN || bytes.first() != Some(&0x04) {
        return Err(PushCryptoError::InvalidP256dhLength);
    }
    PublicKey::from_sec1_bytes(&bytes).map_err(|_| PushCryptoError::InvalidP256dhKey)
}

fn decode_auth_secret(encoded: &str) -> Result<[u8; AUTH_SECRET_LEN], PushCryptoError> {
    let bytes = decode_canonical_base64url(encoded, PushCryptoError::InvalidAuthBase64)?;
    bytes
        .try_into()
        .map_err(|_| PushCryptoError::InvalidAuthLength)
}

fn random_secret_key() -> Result<SecretKey, PushCryptoError> {
    loop {
        let mut bytes = [0_u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|error| PushCryptoError::Randomness(error.to_string()))?;
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return Ok(key);
        }
    }
}

fn encrypt_with_material(
    subscriber_public: &PublicKey,
    auth_secret: &[u8; AUTH_SECRET_LEN],
    plaintext: &[u8],
    sender_private: &SecretKey,
    salt: [u8; SALT_LEN],
) -> Result<EncryptedPush, PushCryptoError> {
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(PushCryptoError::PayloadTooLarge {
            len: plaintext.len(),
            max: MAX_PLAINTEXT_LEN,
        });
    }

    let subscriber_public_bytes = subscriber_public.to_encoded_point(false);
    let sender_public = sender_private.public_key().to_encoded_point(false);
    let sender_public_bytes = sender_public.as_bytes();
    let shared_secret = diffie_hellman(
        sender_private.to_nonzero_scalar(),
        subscriber_public.as_affine(),
    );

    let mut key_info = Vec::with_capacity(14 + 1 + PUBLIC_KEY_LEN * 2);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(subscriber_public_bytes.as_bytes());
    key_info.extend_from_slice(sender_public_bytes);

    let auth_hkdf = Hkdf::<Sha256>::new(Some(auth_secret), shared_secret.raw_secret_bytes());
    let mut ikm = [0_u8; 32];
    auth_hkdf
        .expand(&key_info, &mut ikm)
        .map_err(|_| PushCryptoError::KeyDerivation)?;

    let content_hkdf = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0_u8; 16];
    content_hkdf
        .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| PushCryptoError::KeyDerivation)?;
    let mut nonce = [0_u8; 12];
    content_hkdf
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| PushCryptoError::KeyDerivation)?;

    // RFC 8291 permits exactly one record, whose final delimiter is 0x02.
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| PushCryptoError::Encryption)?;
    let nonce = Nonce::from(nonce);
    let ciphertext = cipher
        .encrypt(&nonce, record.as_ref())
        .map_err(|_| PushCryptoError::Encryption)?;

    let mut body = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(PUBLIC_KEY_LEN as u8);
    body.extend_from_slice(sender_public_bytes);
    body.extend_from_slice(&ciphertext);

    Ok(EncryptedPush {
        body,
        content_encoding: CONTENT_ENCODING,
        ephemeral_public_key: URL_SAFE_NO_PAD.encode(sender_public_bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const RECEIVER_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const SENDER_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const SENDER_PUBLIC: &str =
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";

    fn decode_array<const N: usize>(value: &str) -> [u8; N] {
        URL_SAFE_NO_PAD.decode(value).unwrap().try_into().unwrap()
    }

    fn encrypt_deterministically(plaintext: &[u8]) -> EncryptedPush {
        let receiver = decode_subscriber_public_key(RECEIVER_PUBLIC).unwrap();
        let auth = decode_auth_secret(AUTH).unwrap();
        let sender = SecretKey::from_slice(&decode_array::<32>(SENDER_PRIVATE)).unwrap();
        encrypt_with_material(&receiver, &auth, plaintext, &sender, decode_array(SALT)).unwrap()
    }

    #[test]
    fn matches_rfc_8291_example() {
        let encrypted = encrypt_deterministically(b"When I grow up, I want to be a watermelon");
        let expected = concat!(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        );

        assert_eq!(URL_SAFE_NO_PAD.encode(&encrypted.body), expected);
        assert_eq!(encrypted.content_encoding, "aes128gcm");
        assert_eq!(encrypted.ephemeral_public_key, SENDER_PUBLIC);
    }

    #[test]
    fn rejects_noncanonical_or_wrong_length_subscription_values() {
        assert_eq!(
            decode_subscriber_public_key(&format!("{RECEIVER_PUBLIC}=")).unwrap_err(),
            PushCryptoError::InvalidP256dhBase64
        );
        assert_eq!(
            decode_subscriber_public_key("BA").unwrap_err(),
            PushCryptoError::InvalidP256dhLength
        );
        assert_eq!(
            decode_auth_secret(&URL_SAFE_NO_PAD.encode([0_u8; 15])).unwrap_err(),
            PushCryptoError::InvalidAuthLength
        );
    }

    #[test]
    fn rejects_compressed_and_off_curve_public_keys() {
        let receiver = decode_subscriber_public_key(RECEIVER_PUBLIC).unwrap();
        let compressed = URL_SAFE_NO_PAD.encode(receiver.to_encoded_point(true).as_bytes());
        assert_eq!(
            decode_subscriber_public_key(&compressed).unwrap_err(),
            PushCryptoError::InvalidP256dhLength
        );

        let mut off_curve = [0_u8; PUBLIC_KEY_LEN];
        off_curve[0] = 0x04;
        assert_eq!(
            decode_subscriber_public_key(&URL_SAFE_NO_PAD.encode(off_curve)).unwrap_err(),
            PushCryptoError::InvalidP256dhKey
        );
    }

    #[test]
    fn enforces_push_service_payload_limit() {
        let receiver = decode_subscriber_public_key(RECEIVER_PUBLIC).unwrap();
        let auth = decode_auth_secret(AUTH).unwrap();
        let sender = SecretKey::from_slice(&decode_array::<32>(SENDER_PRIVATE)).unwrap();
        let error = encrypt_with_material(
            &receiver,
            &auth,
            &vec![0; MAX_PLAINTEXT_LEN + 1],
            &sender,
            decode_array(SALT),
        )
        .unwrap_err();

        assert_eq!(
            error,
            PushCryptoError::PayloadTooLarge {
                len: MAX_PLAINTEXT_LEN + 1,
                max: MAX_PLAINTEXT_LEN,
            }
        );
        assert_eq!(
            encrypt_deterministically(&vec![0; MAX_PLAINTEXT_LEN])
                .body
                .len(),
            4096
        );
    }
}
