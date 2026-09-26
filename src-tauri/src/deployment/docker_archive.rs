use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn sha256_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
struct DockerSaveManifestEntry {
    config: String,
    repo_tags: Vec<String>,
    layers: Vec<String>,
}

fn docker_config_digest(path: &str) -> Result<&str, String> {
    let components = Path::new(path).components().collect::<Vec<_>>();
    let digest = match components.as_slice() {
        [std::path::Component::Normal(blobs), std::path::Component::Normal(algorithm), std::path::Component::Normal(digest)]
            if blobs.to_str() == Some("blobs") && algorithm.to_str() == Some("sha256") =>
        {
            digest.to_str()
        }
        [std::path::Component::Normal(file)] => file
            .to_str()
            .and_then(|file| file.strip_suffix(".json")),
        _ => None,
    }
    .ok_or_else(|| "Docker save manifest contains an unsafe config path".to_string())?;
    if !valid_sha256(digest) {
        return Err("Docker save manifest contains an invalid config digest".into());
    }
    Ok(digest)
}

pub(crate) struct DockerArchiveIdentity {
    pub config_id: String,
    pub manifest_id: Option<String>,
}

type ArchiveEntryReader<'a> = dyn Fn(&str, u64) -> Result<Option<Vec<u8>>, String> + 'a;

fn verify_oci_manifest(
    descriptor: &serde_json::Value,
    config_id: &str,
    read_entry: &ArchiveEntryReader<'_>,
    depth: u8,
) -> Result<u32, String> {
    if depth > 3 {
        return Err("OCI index nesting exceeds limit".into());
    }
    let digest = descriptor
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| valid_sha256(value))
        .ok_or_else(|| "invalid OCI digest".to_string())?;
    let bytes = read_entry(&format!("blobs/sha256/{digest}"), 64 * 1024)?
        .ok_or_else(|| "OCI manifest missing".to_string())?;
    if sha256_bytes(&bytes) != digest {
        return Err("OCI manifest digest mismatch".into());
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid OCI manifest".to_string())?;
    if manifest
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(2)
    {
        return Err("unsupported OCI schema".into());
    }
    if descriptor
        .pointer("/annotations/vnd.docker.reference.type")
        .and_then(serde_json::Value::as_str)
        == Some("attestation-manifest")
        && descriptor
            .pointer("/platform/os")
            .and_then(serde_json::Value::as_str)
            == Some("unknown")
    {
        return Ok(0);
    }
    if let Some(children) = manifest
        .get("manifests")
        .and_then(serde_json::Value::as_array)
    {
        if children.is_empty() || children.len() > 16 {
            return Err("OCI descriptor count exceeds limit".into());
        }
        let mut matches = 0;
        for child in children {
            matches += verify_oci_manifest(child, config_id, read_entry, depth + 1)?;
        }
        return Ok(matches);
    }
    if manifest
        .pointer("/config/digest")
        .and_then(serde_json::Value::as_str)
        != Some(config_id)
    {
        return Err("OCI manifest does not reference the approved config".into());
    }
    Ok(1)
}

pub(crate) fn docker_archive_image_identity(
    archive_path: &Path,
    image_reference: &str,
) -> Result<DockerArchiveIdentity, String> {
    const MAX_DOCKER_MANIFEST_BYTES: u64 = 64 * 1024;
    const MAX_DOCKER_CONFIG_BYTES: u64 = 1024 * 1024;
    let read_entry = |wanted: &str, max_bytes: u64| -> Result<Option<Vec<u8>>, String> {
        let file = File::open(archive_path)
            .map_err(|error| format!("failed to open Docker image archive: {error}"))?;
        let mut archive = tar::Archive::new(file);
        let entries = archive
            .entries()
            .map_err(|error| format!("failed to inspect Docker image archive: {error}"))?;
        let mut found = None;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("failed to inspect Docker image archive: {error}"))?;
            let path = entry
                .path()
                .map_err(|error| format!("Docker image archive path is invalid: {error}"))?;
            if path != Path::new(wanted) {
                continue;
            }
            if found.is_some() || !entry.header().entry_type().is_file() || entry.size() > max_bytes
            {
                return Err("Docker image archive contains an invalid duplicate entry".into());
            }
            let mut bytes = Vec::new();
            entry
                .take(max_bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("failed to read Docker image archive entry: {error}"))?;
            if bytes.len() as u64 > max_bytes {
                return Err("Docker image archive entry exceeds its safety limit".into());
            }
            found = Some(bytes);
        }
        Ok(found)
    };
    let manifest_bytes = read_entry("manifest.json", MAX_DOCKER_MANIFEST_BYTES)?
        .ok_or_else(|| "Docker image archive has no manifest.json".to_string())?;
    let entries: Vec<DockerSaveManifestEntry> = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Docker image archive manifest is invalid: {error}"))?;
    if entries.is_empty() || entries.len() > 64 {
        return Err("Docker image archive manifest entry count is invalid".into());
    }
    let mut matches = entries
        .iter()
        .filter(|entry| entry.repo_tags.iter().any(|tag| tag == image_reference));
    let selected = matches.next().ok_or_else(|| {
        "Docker image archive does not contain the approved image reference".to_string()
    })?;
    if matches.next().is_some()
        || selected.repo_tags.is_empty()
        || selected.repo_tags.len() > 64
        || selected.layers.is_empty()
        || selected.layers.len() > 256
    {
        return Err("Docker image archive image identity is ambiguous".into());
    }
    let digest = docker_config_digest(&selected.config)?;
    let config_bytes = read_entry(&selected.config, MAX_DOCKER_CONFIG_BYTES)?
        .ok_or_else(|| "Docker image archive config is missing".to_string())?;
    if sha256_bytes(&config_bytes) != digest {
        return Err("Docker image archive config digest does not match its content".into());
    }
    let config_id = format!("sha256:{digest}");
    // Docker's classic store identifies an image by its config; containerd's
    // store identifies it by the OCI manifest. Accept only identities proven
    // to reference the very same config in this verified archive.
    let manifest_id = if let Some(index) = read_entry("index.json", MAX_DOCKER_MANIFEST_BYTES)? {
        let index: serde_json::Value =
            serde_json::from_slice(&index).map_err(|_| "invalid OCI archive index".to_string())?;
        let descriptors = index
            .get("manifests")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "OCI archive descriptors missing".to_string())?;
        if descriptors.len() != 1 {
            return Err("multi-image OCI archives are unsupported".into());
        }
        let descriptor = &descriptors[0];
        let reference = descriptor
            .get("digest")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "OCI manifest digest missing".to_string())?;
        let hex = reference
            .strip_prefix("sha256:")
            .filter(|hex| valid_sha256(hex))
            .ok_or_else(|| "OCI manifest digest invalid".to_string())?;
        let bytes = read_entry(&format!("blobs/sha256/{hex}"), MAX_DOCKER_MANIFEST_BYTES)?
            .ok_or_else(|| "OCI manifest content missing".to_string())?;
        if sha256_bytes(&bytes) != hex {
            return Err("OCI manifest digest mismatch".into());
        }
        if verify_oci_manifest(descriptor, &config_id, &read_entry, 0)? != 1 {
            return Err("OCI archive must contain exactly one runnable image".into());
        }
        Some(reference.to_owned())
    } else {
        None
    };
    Ok(DockerArchiveIdentity {
        config_id,
        manifest_id,
    })
}
