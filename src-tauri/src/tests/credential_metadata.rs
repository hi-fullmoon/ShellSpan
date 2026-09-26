use super::*;

fn generate_key(directory: &std::path::Path, name: &str) -> (String, String) {
    let path = directory.join(name);
    let output = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&path)
        .output()
        .expect("ssh-keygen is required for real credential format tests");
    assert!(output.status.success(), "SSH key generation failed");
    (
        std::fs::read_to_string(&path).unwrap(),
        std::fs::read_to_string(path.with_extension("pub")).unwrap(),
    )
}

fn request(private_key: Option<String>) -> KeyCredentialRequest {
    KeyCredentialRequest {
        id: "credential-format-test".into(),
        label: "Renamed credential".into(),
        kind: crate::models::KeyCredentialKind::KeyFile,
        private_key,
        public_key: None,
        key_type: None,
    }
}

#[test]
fn credential_metadata_preserves_secrets_and_derives_real_public_key() {
    let directory = tempfile::tempdir().unwrap();
    let (private_key, public_key) = generate_key(directory.path(), "identity");
    let previous = serde_json::json!({ "privateKey": private_key });
    let mut update = request(None);
    prepare_key_credential(&mut update, Some(&previous.to_string())).unwrap();
    assert!(
        update.private_key.as_deref() == Some(private_key.as_str()),
        "Rename must preserve the private key"
    );
    let expected = ssh_key::PublicKey::from_openssh(&public_key).unwrap();
    let actual = ssh_key::PublicKey::from_openssh(update.public_key.as_deref().unwrap()).unwrap();
    assert_eq!(actual.key_data(), expected.key_data());
    assert_eq!(update.key_type.as_deref(), Some("ssh-ed25519"));

    let database = Database::open(&directory.path().join("credentials.sqlite")).unwrap();
    database
        .upsert_key_credential(
            &update.id,
            &update.label,
            update.key_type.as_deref().unwrap(),
            "keyfile",
            crate::keychain::KEY_SERVICE,
            update.public_key.as_deref(),
            None,
            0,
        )
        .unwrap();
    let summaries = database.list_key_credentials().unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].public_key, update.public_key);
    assert_eq!(
        summaries[0].fingerprint.as_deref(),
        Some(
            actual
                .fingerprint(ssh_key::HashAlg::Sha256)
                .to_string()
                .as_str()
        )
    );
    let serialized = serde_json::to_value(&summaries[0]).unwrap();
    assert!(serialized.get("privateKey").is_none());
    assert!(!serialized.to_string().contains("PRIVATE KEY"));

    let output = std::process::Command::new("ssh-keygen")
        .args(["-l", "-E", "sha256", "-f"])
        .arg(directory.path().join("identity.pub"))
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains(&actual.fingerprint(ssh_key::HashAlg::Sha256).to_string()));
}

#[test]
fn credential_replacement_rejects_mismatched_public_keys() {
    let directory = tempfile::tempdir().unwrap();
    let (first, first_public) = generate_key(directory.path(), "first");
    let (second, _) = generate_key(directory.path(), "second");
    let mut update = request(Some(second.clone()));
    update.public_key = Some(first_public);
    assert!(prepare_key_credential(&mut update, None).is_err());
    update.public_key = Some(String::new());
    let previous = serde_json::json!({ "privateKey": first });
    prepare_key_credential(&mut update, Some(&previous.to_string())).unwrap();
    assert!(
        update.private_key.as_deref() == Some(second.as_str()),
        "Replacement must persist the new private key"
    );
    assert!(update.public_key.is_some());
}

#[test]
fn credential_metadata_does_not_create_missing_or_empty_secrets() {
    assert!(prepare_key_credential(&mut request(None), None).is_err());
    assert!(prepare_key_credential(&mut request(Some(String::new())), None).is_err());
}
