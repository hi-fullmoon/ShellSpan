use base64::Engine;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;

const PBKDF2_ITERATIONS: u32 = 100_000;
const ECDSA_SALT: &[u8] = b"TermBridgeECDSAKeyV1";

/// Derives a deterministic ECDSA P-256 key pair from a password.
///
/// Returns `(private_key_pem, public_key_openssh)` where:
/// - `private_key_pem` is a PKCS#8 PEM encoded private key suitable for libssh2.
/// - `public_key_openssh` is an OpenSSH authorized_keys line fragment
///   (`ecdsa-sha2-nistp256 AAA...`).
pub(crate) fn derive_ecdsa_key_from_password(password: &str) -> Result<(String, String), String> {
    let mut seed = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), ECDSA_SALT, PBKDF2_ITERATIONS, &mut seed);

    let secret_key = p256::SecretKey::from_slice(&seed)
        .map_err(|e| format!("invalid ecdsa secret key: {e}"))?;

    let private_pem = secret_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| format!("failed to encode private key: {e}"))?
        .to_string();

    let public_key = secret_key.public_key();
    let encoded_point = public_key.to_encoded_point(false);
    let public_openssh = encode_ecdsa_openssh_public_key(encoded_point.as_bytes());

    Ok((private_pem, public_openssh))
}

fn encode_ecdsa_openssh_public_key(public_key_bytes: &[u8]) -> String {
    let mut buf = Vec::new();
    write_string(&mut buf, b"ecdsa-sha2-nistp256");
    write_string(&mut buf, b"nistp256");
    write_string(&mut buf, public_key_bytes);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf);
    format!("ecdsa-sha2-nistp256 {encoded}")
}

fn write_string(buf: &mut Vec<u8>, s: &[u8]) {
    buf.extend_from_slice(&(s.len() as u32).to_be_bytes());
    buf.extend_from_slice(s);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_password_derives_same_key() {
        let (priv1, pub1) = derive_ecdsa_key_from_password("my-secret-password").unwrap();
        let (priv2, pub2) = derive_ecdsa_key_from_password("my-secret-password").unwrap();
        assert_eq!(priv1, priv2);
        assert_eq!(pub1, pub2);
        assert!(pub1.starts_with("ecdsa-sha2-nistp256 "));
        assert!(priv1.starts_with("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn different_passwords_derive_different_keys() {
        let (_, pub1) = derive_ecdsa_key_from_password("password-one").unwrap();
        let (_, pub2) = derive_ecdsa_key_from_password("password-two").unwrap();
        assert_ne!(pub1, pub2);
    }
}
