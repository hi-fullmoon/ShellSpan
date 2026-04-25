use log::{debug, error, info, warn};
use ssh2::{CheckResult, HostKeyType, KnownHostFileKind, KnownHostKeyFormat};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::connection::open_session_for_host_key;
use crate::models::{HostKeyCheckRequest, HostKeyCheckResult, HostKeyCheckStatus, TrustHostRequest};

const KNOWN_HOSTS_FILENAME: &str = "known_hosts";

fn get_known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve app local data dir: {error}"))?;
    Ok(app_local_data.join(KNOWN_HOSTS_FILENAME))
}

fn ensure_known_hosts_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create known hosts directory: {error}"))?;
    }
    Ok(())
}

fn base64url_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut result = String::with_capacity((input.len() * 4 + 2) / 3);
    for chunk in input.chunks(3) {
        let b = match chunk.len() {
            1 => [chunk[0], 0, 0],
            2 => [chunk[0], chunk[1], 0],
            _ => [chunk[0], chunk[1], chunk[2]],
        };
        result.push(ALPHABET[(b[0] >> 2) as usize] as char);
        result.push(ALPHABET[(((b[0] & 0x3) << 4) | (b[1] >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(ALPHABET[(((b[1] & 0xF) << 2) | (b[2] >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            result.push(ALPHABET[(b[2] & 0x3F) as usize] as char);
        }
    }
    result
}

fn compute_fingerprint(key: &[u8], key_type: HostKeyType) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(key);
    let b64 = base64url_encode(&hash);
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

    let session = open_session_for_host_key(host, port)?;

    let (key, key_type) = session.host_key().ok_or_else(|| {
        "failed to retrieve host key from ssh session".to_string()
    })?;

    let fingerprint = compute_fingerprint(key, key_type);

    let known_hosts_path = get_known_hosts_path(app)?;
    let mut known_hosts = session.known_hosts().map_err(|error| {
        format!("failed to initialize known hosts: {error}")
    })?;

    if known_hosts_path.exists() {
        match known_hosts.read_file(&known_hosts_path, KnownHostFileKind::OpenSSH) {
            Ok(count) => debug!("Loaded {count} known hosts from file"),
            Err(error) => warn!("Failed to read known hosts file: {error}"),
        }
    }

    let check_result = if port == 22 {
        known_hosts.check(host, key)
    } else {
        known_hosts.check_port(host, port, key)
    };

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

    let session = open_session_for_host_key(host, port)?;

    let (key, key_type) = session.host_key().ok_or_else(|| {
        "failed to retrieve host key from ssh session".to_string()
    })?;

    let known_hosts_path = get_known_hosts_path(app)?;
    ensure_known_hosts_dir(&known_hosts_path)?;

    let mut known_hosts = session.known_hosts().map_err(|error| {
        format!("failed to initialize known hosts: {error}")
    })?;

    if known_hosts_path.exists() {
        match known_hosts.read_file(&known_hosts_path, KnownHostFileKind::OpenSSH) {
            Ok(count) => debug!("Loaded {count} known hosts from file"),
            Err(error) => warn!("Failed to read known hosts file: {error}"),
        }
    }

    let host_with_port = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };

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
