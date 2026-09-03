use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use hmac::{Hmac, Mac};
use log::{debug, error, info, warn};
use sha1::Sha1;
use ssh2::{CheckResult, HostKeyType, KnownHostFileKind, KnownHostKeyFormat, Session};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

use crate::connection::{open_session_for_host_key, validate_host};
use crate::models::{
    HostKeyCheckRequest, HostKeyCheckResult, HostKeyCheckStatus, TrustHostRequest,
};

const KNOWN_HOSTS_FILENAME: &str = "known_hosts";

/// Serializes writes to the known_hosts file to prevent corruption when multiple
/// operations trust or remove hosts concurrently.
pub(crate) static KNOWN_HOSTS_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn known_hosts_path_from_home(home: Result<PathBuf, String>) -> Result<PathBuf, String> {
    home.map(|path| crate::shellspan_data_dir(&path).join(KNOWN_HOSTS_FILENAME))
}

pub(crate) fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve home dir: {error}"));
    known_hosts_path_from_home(home)
}

fn get_known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    known_hosts_path(app)
}

pub(crate) fn check_host_key_against_file(
    session: &Session,
    host: &str,
    port: u16,
    known_hosts_file: &Path,
) -> Result<HostKeyCheckResult, HostKeyCheckResult> {
    let (key, key_type) = session.host_key().ok_or_else(|| HostKeyCheckResult {
        status: HostKeyCheckStatus::Failure,
        fingerprint: None,
        message: Some("failed to retrieve host key from ssh session".to_string()),
    })?;

    let fingerprint = compute_fingerprint(key, key_type);

    let mut known_hosts = session.known_hosts().map_err(|error| HostKeyCheckResult {
        status: HostKeyCheckStatus::Failure,
        fingerprint: Some(fingerprint.clone()),
        message: Some(format!("failed to initialize known hosts: {error}")),
    })?;

    if known_hosts_file.exists() {
        let count = known_hosts
            .read_file(known_hosts_file, KnownHostFileKind::OpenSSH)
            .map_err(|error| HostKeyCheckResult {
                status: HostKeyCheckStatus::Failure,
                fingerprint: Some(fingerprint.clone()),
                message: Some(format!("failed to read known hosts file: {error}")),
            })?;
        debug!("Loaded {count} known hosts from file");
    }

    let check_result = check_host_key_exact_endpoint(&known_hosts, host, port, key);

    match check_result {
        CheckResult::Match => {
            debug!("Host key matches known hosts for {host}:{port}");
            Ok(HostKeyCheckResult {
                status: HostKeyCheckStatus::Match,
                fingerprint: Some(fingerprint),
                message: None,
            })
        }
        CheckResult::Mismatch => {
            let message = format!(
                "host key for {host}:{port} does not match the known key — possible man-in-the-middle attack"
            );
            Err(HostKeyCheckResult {
                status: HostKeyCheckStatus::Mismatch,
                fingerprint: Some(fingerprint),
                message: Some(message),
            })
        }
        CheckResult::NotFound => {
            let message = format!(
                "host key for {host}:{port} is not known — trust this host before connecting"
            );
            Err(HostKeyCheckResult {
                status: HostKeyCheckStatus::NotFound,
                fingerprint: Some(fingerprint),
                message: Some(message),
            })
        }
        CheckResult::Failure => {
            let message = format!("failed to verify host key for {host}:{port}");
            Err(HostKeyCheckResult {
                status: HostKeyCheckStatus::Failure,
                fingerprint: Some(fingerprint),
                message: Some(message),
            })
        }
    }
}

fn ensure_known_hosts_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create known hosts directory: {error}"))?;
    }
    Ok(())
}

pub(crate) fn compute_fingerprint(key: &[u8], key_type: HostKeyType) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(key);
    // OpenSSH fingerprints use standard Base64 without padding. URL-safe
    // encoding would display '-'/'_' instead of '+'/'/' for some keys and
    // prevent users from comparing the prompt with ssh-keygen/provider output.
    let b64 = STANDARD_NO_PAD.encode(hash);
    let type_prefix = match key_type {
        HostKeyType::Rsa => "RSA",
        HostKeyType::Dss => "DSA",
        HostKeyType::Ecdsa256 | HostKeyType::Ecdsa384 | HostKeyType::Ecdsa521 => "ECDSA",
        HostKeyType::Ed25519 => "ED25519",
        HostKeyType::Unknown => "UNKNOWN",
    };
    format!("{type_prefix} SHA256:{b64}")
}

pub(crate) fn check_host_key_blocking(
    app: &AppHandle,
    request: &HostKeyCheckRequest,
) -> Result<HostKeyCheckResult, String> {
    let host = request.host.trim();
    let port = request.port;

    debug!("Checking host key for {host}:{port}");
    validate_host(host)?;

    let session = open_session_for_host_key(host, port)?;

    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| "failed to retrieve host key from ssh session".to_string())?;

    let fingerprint = compute_fingerprint(key, key_type);

    let known_hosts_path = get_known_hosts_path(app)?;
    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| format!("failed to initialize known hosts: {error}"))?;

    if known_hosts_path.exists() {
        let count = known_hosts
            .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
            .map_err(|error| format!("failed to read known hosts file: {error}"))?;
        debug!("Loaded {count} known hosts from file");
    }

    let check_result = check_host_key_exact_endpoint(&known_hosts, host, port, key);

    let status = match check_result {
        CheckResult::Match => {
            info!("Host key matches known hosts for {host}:{port}");
            HostKeyCheckStatus::Match
        }
        CheckResult::Mismatch => {
            warn!("Host key MISMATCH for {host}:{port} — possible MITM attack");
            HostKeyCheckStatus::Mismatch
        }
        CheckResult::NotFound => {
            info!("Host key not found for {host}:{port}");
            HostKeyCheckStatus::NotFound
        }
        CheckResult::Failure => {
            error!("Host key check failed for {host}:{port}");
            HostKeyCheckStatus::Failure
        }
    };

    let message = match status {
        HostKeyCheckStatus::Match => None,
        HostKeyCheckStatus::Mismatch => Some(
            format!("The host key for {host}:{port} does not match the known key. This may indicate a man-in-the-middle attack.")
        ),
        HostKeyCheckStatus::NotFound => Some(
            format!("First time connecting to {host}:{port}. Please verify the host fingerprint before trusting it.")
        ),
        HostKeyCheckStatus::Failure => Some(
            format!("Failed to check the host key for {host}:{port}.")
        ),
    };

    Ok(HostKeyCheckResult {
        status,
        fingerprint: Some(fingerprint),
        message,
    })
}

pub(crate) fn trust_host_blocking(
    app: &AppHandle,
    request: &TrustHostRequest,
) -> Result<(), String> {
    let host = request.host.trim();
    let port = request.port;

    info!("Trusting host {host}:{port}");
    validate_host(host)?;

    let _lock = KNOWN_HOSTS_WRITE_LOCK
        .lock()
        .map_err(|_| "known hosts write lock poisoned".to_string())?;

    let session = open_session_for_host_key(host, port)?;

    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| "failed to retrieve host key from ssh session".to_string())?;
    let fingerprint = compute_fingerprint(key, key_type);
    ensure_confirmed_host_fingerprint(&request.expected_fingerprint, &fingerprint)?;

    let known_hosts_path = get_known_hosts_path(app)?;
    ensure_known_hosts_dir(&known_hosts_path)?;
    let host_with_port = known_hosts_endpoint(host, port);

    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| format!("failed to initialize known hosts: {error}"))?;

    if known_hosts_path.exists() {
        let count = read_known_hosts_excluding_endpoint(
            &mut known_hosts,
            &known_hosts_path,
            &host_with_port,
        )?;
        debug!("Loaded {count} known hosts from file");
    }

    let key_format = match key_type {
        HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
        HostKeyType::Dss => KnownHostKeyFormat::SshDss,
        HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
        HostKeyType::Ecdsa384 => KnownHostKeyFormat::Ecdsa384,
        HostKeyType::Ecdsa521 => KnownHostKeyFormat::Ecdsa521,
        HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
        HostKeyType::Unknown => KnownHostKeyFormat::Unknown,
    };

    known_hosts
        .add(&host_with_port, key, &host_with_port, key_format)
        .map_err(|error| format!("failed to add host to known hosts: {error}"))?;

    known_hosts
        .write_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
        .map_err(|error| format!("failed to write known hosts file: {error}"))?;

    info!("Added {host}:{port} to known hosts file");
    Ok(())
}

fn ensure_confirmed_host_fingerprint(expected: &str, actual: &str) -> Result<(), String> {
    let expected = expected.trim();
    if expected.is_empty() {
        return Err("host key fingerprint confirmation is required".to_string());
    }
    if expected != actual {
        return Err(format!(
            "host key changed before trust confirmation: expected {expected}, received {actual}"
        ));
    }
    Ok(())
}

fn known_hosts_endpoint(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

fn check_host_key_exact_endpoint(
    known_hosts: &ssh2::KnownHosts,
    host: &str,
    port: u16,
    key: &[u8],
) -> CheckResult {
    // libssh2's check_port falls back from `[host]:port` to a plain `host`
    // entry. That would let a key trusted for port 22 satisfy a different
    // port after that endpoint was explicitly rotated. Check the exact token
    // instead, including its hashed OpenSSH form.
    let endpoint = known_hosts_endpoint(host, port);
    known_hosts.check(&endpoint, key)
}

fn read_known_hosts_excluding_endpoint(
    known_hosts: &mut ssh2::KnownHosts,
    path: &Path,
    endpoint: &str,
) -> Result<u32, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read known hosts file: {error}"))?;
    let mut loaded = 0_u32;
    for (index, line) in contents.lines().enumerate() {
        let Some(filtered) = filter_known_hosts_line(line, endpoint)
            .map_err(|error| format!("failed to filter known hosts line {}: {error}", index + 1))?
        else {
            continue;
        };
        known_hosts
            .read_str(&filtered, KnownHostFileKind::OpenSSH)
            .map_err(|error| format!("failed to read known hosts line {}: {error}", index + 1))?;
        loaded = loaded.saturating_add(1);
    }
    Ok(loaded)
}

fn filter_known_hosts_line(line: &str, endpoint: &str) -> Result<Option<String>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return Ok(None);
    }

    let mut fields = trimmed
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let host_index = usize::from(fields.first().is_some_and(|field| field.starts_with('@')));
    if fields.len() < host_index + 3 {
        return Err("invalid OpenSSH known-hosts entry".to_string());
    }

    let mut removed = false;
    let mut retained_patterns = Vec::new();
    for pattern in fields[host_index].split(',') {
        if known_host_pattern_matches_endpoint(pattern, endpoint)? {
            removed = true;
        } else {
            retained_patterns.push(pattern);
        }
    }
    if !removed {
        return Ok(Some(trimmed.to_string()));
    }
    if retained_patterns.is_empty() {
        return Ok(None);
    }
    fields[host_index] = retained_patterns.join(",");
    Ok(Some(fields.join(" ")))
}

fn known_host_pattern_matches_endpoint(pattern: &str, endpoint: &str) -> Result<bool, String> {
    if pattern == endpoint {
        return Ok(true);
    }
    if !pattern.starts_with('|') {
        return Ok(false);
    }

    let mut parts = pattern.split('|');
    if parts.next() != Some("") || parts.next() != Some("1") {
        return Err("unsupported hashed known-host algorithm".to_string());
    }
    let salt = parts
        .next()
        .ok_or_else(|| "hashed known-host entry is missing its salt".to_string())?;
    let expected = parts
        .next()
        .ok_or_else(|| "hashed known-host entry is missing its digest".to_string())?;
    if parts.next().is_some() {
        return Err("hashed known-host entry has unexpected fields".to_string());
    }
    let salt = STANDARD
        .decode(salt)
        .map_err(|error| format!("invalid hashed known-host salt: {error}"))?;
    let expected = STANDARD
        .decode(expected)
        .map_err(|error| format!("invalid hashed known-host digest: {error}"))?;
    let mut mac = Hmac::<Sha1>::new_from_slice(&salt)
        .map_err(|error| format!("invalid hashed known-host salt: {error}"))?;
    mac.update(endpoint.as_bytes());
    Ok(mac.verify_slice(&expected).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn fingerprint_uses_openssh_standard_base64_without_padding() {
        let fingerprint = compute_fingerprint(b"standard-base64-fixture", HostKeyType::Ed25519);
        let digest = sha2::Sha256::digest(b"standard-base64-fixture");
        assert_eq!(
            fingerprint,
            format!("ED25519 SHA256:{}", STANDARD_NO_PAD.encode(digest))
        );
    }

    #[test]
    fn known_hosts_path_resolution_fails_closed() {
        let error = known_hosts_path_from_home(Err("home directory unavailable".to_string()))
            .expect_err("a missing home directory must not become an absent host-key policy");

        assert_eq!(error, "home directory unavailable");
    }

    #[test]
    fn known_hosts_path_uses_the_build_specific_shellspan_location() {
        let home = PathBuf::from("test-home");

        assert_eq!(
            known_hosts_path_from_home(Ok(home.clone())).unwrap(),
            crate::shellspan_data_dir(&home).join("known_hosts")
        );
    }

    #[test]
    fn trust_requires_the_fingerprint_that_was_confirmed() {
        assert!(ensure_confirmed_host_fingerprint(
            "ED25519 SHA256:confirmed",
            "ED25519 SHA256:confirmed"
        )
        .is_ok());
        assert!(ensure_confirmed_host_fingerprint("", "ED25519 SHA256:actual").is_err());

        let error =
            ensure_confirmed_host_fingerprint("ED25519 SHA256:confirmed", "ED25519 SHA256:changed")
                .expect_err("a key changed after the prompt must not be persisted");
        assert!(error.contains("changed before trust confirmation"));
    }

    #[test]
    fn trusting_a_rotated_key_removes_plain_and_hashed_endpoint_entries() {
        let session = Session::new().expect("session should initialize");
        let mut known_hosts = session
            .known_hosts()
            .expect("known hosts should initialize");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("known_hosts");
        let endpoint = "[example.com]:2222";
        let salt = b"01234567890123456789";
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        mac.update(endpoint.as_bytes());
        let hashed_endpoint = format!(
            "|1|{}|{}",
            STANDARD.encode(salt),
            STANDARD.encode(mac.finalize().into_bytes())
        );
        std::fs::write(
            &path,
            format!(
                "{endpoint} ssh-ed25519 Zmlyc3Q=\n{hashed_endpoint} ssh-rsa c2Vjb25k\nother.example.com ssh-ed25519 b3RoZXI=\n"
            ),
        )
        .unwrap();

        let loaded = read_known_hosts_excluding_endpoint(&mut known_hosts, &path, endpoint)
            .expect("old endpoint entries should be removed");

        let remaining = known_hosts.hosts().expect("known hosts should enumerate");
        assert_eq!(loaded, 1);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].name(), Some("other.example.com"));
    }

    #[test]
    fn filtering_one_plain_alias_preserves_the_other_aliases() {
        assert_eq!(
            filter_known_hosts_line(
                "example.com,alias.example.com ssh-ed25519 b2xk",
                "example.com"
            )
            .unwrap(),
            Some("alias.example.com ssh-ed25519 b2xk".to_string())
        );
    }

    #[test]
    fn nonstandard_port_does_not_fall_back_to_the_default_port_key() {
        let session = Session::new().unwrap();
        let mut known_hosts = session.known_hosts().unwrap();
        known_hosts
            .add(
                "example.com",
                b"default-port-key",
                "default",
                KnownHostKeyFormat::Ed25519,
            )
            .unwrap();
        known_hosts
            .add(
                "[example.com]:2222",
                b"alternate-port-key",
                "alternate",
                KnownHostKeyFormat::Ed25519,
            )
            .unwrap();

        assert!(!matches!(
            check_host_key_exact_endpoint(&known_hosts, "example.com", 2222, b"default-port-key"),
            CheckResult::Match
        ));
        assert!(matches!(
            check_host_key_exact_endpoint(&known_hosts, "example.com", 2222, b"alternate-port-key"),
            CheckResult::Match
        ));
    }
}
