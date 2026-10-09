//! Real OS keychain entries owned by this test; no user vault read or substitute.
use super::*;

#[test]
fn noninteractive_acceptance_reads_only_its_exact_owned_keychain_item() {
    let service = format!("ShellSpan.NativeAcceptance.{}", uuid::Uuid::new_v4());
    let account = uuid::Uuid::new_v4().to_string();
    let secret = uuid::Uuid::new_v4().to_string();
    NativeKeychainBackend
        .set_credential(&service, &account, &secret)
        .unwrap();
    let found = macos_keychain::get_generic_password_without_authentication(&service, &account);
    let other = macos_keychain::get_generic_password_without_authentication(
        &service,
        &uuid::Uuid::new_v4().to_string(),
    );
    let removed = NativeKeychainBackend.delete_credential(&service, &account);
    assert!(removed.is_ok(), "owned keychain item cleanup failed");
    assert!(
        found.ok().flatten().as_deref() == Some(secret.as_str()),
        "noninteractive lookup must read the owned exact item"
    );
    assert!(
        matches!(other, Ok(None)),
        "lookup must not broaden the account filter"
    );
}

#[test]
fn readonly_model_acceptance_refuses_other_references_before_accessing_user_vault() {
    let reference = uuid::Uuid::new_v4().to_string();
    let credentials = CredentialManager::readonly_model_check(Some(reference.clone()));
    assert!(credentials
        .get_credential(AI_KEY_SERVICE, &uuid::Uuid::new_v4().to_string())
        .is_err());
    assert!(credentials
        .get_credential("ShellSpan.OtherService", &reference)
        .is_err());
    assert!(credentials
        .set_credential(AI_KEY_SERVICE, &reference, "forbidden")
        .is_err());
    assert!(credentials
        .delete_credential(AI_KEY_SERVICE, &reference)
        .is_err());
}

#[test]
fn model_and_fixture_acceptance_reads_only_its_new_ssh_key_without_write_authority() {
    let key_id = uuid::Uuid::new_v4().to_string();
    let secret = uuid::Uuid::new_v4().to_string();
    let native = CredentialManager::isolated_native_for_checks();
    native.store_key_credential(&key_id, &secret).unwrap();
    let profile_id = uuid::Uuid::new_v4().to_string();
    let passphrase = uuid::Uuid::new_v4().to_string();
    let stored_passphrase =
        native.store_profile_secret(&profile_id, ProfileSecretKind::Passphrase, &passphrase);
    let restricted = CredentialManager::readonly_model_check_with_fixture_key(
        None,
        key_id.clone(),
        profile_id.clone(),
    );
    let found_passphrase =
        restricted.retrieve_profile_secret(&profile_id, ProfileSecretKind::Passphrase);
    let other_passphrase = restricted.retrieve_profile_secret(
        &uuid::Uuid::new_v4().to_string(),
        ProfileSecretKind::Passphrase,
    );
    let other_kind =
        restricted.retrieve_profile_secret(&profile_id, ProfileSecretKind::JumpPassphrase);
    let denied_passphrase_write =
        restricted.store_profile_secret(&profile_id, ProfileSecretKind::Passphrase, "forbidden");
    let denied_passphrase_delete =
        restricted.delete_profile_secret(&profile_id, ProfileSecretKind::Passphrase);
    let found = restricted.retrieve_key_credential(&key_id);
    let other = restricted.retrieve_key_credential(&uuid::Uuid::new_v4().to_string());
    let denied_write = restricted.store_key_credential(&key_id, "forbidden");
    let denied_delete = restricted.delete_key_credential(&key_id);
    let removed = native.delete_key_credential(&key_id);
    let removed_passphrase =
        native.delete_profile_secret(&profile_id, ProfileSecretKind::Passphrase);
    assert!(removed.is_ok(), "owned SSH fixture key cleanup failed");
    assert!(
        removed_passphrase.is_ok(),
        "owned fixture passphrase cleanup failed"
    );
    assert!(stored_passphrase.is_ok());
    assert!(found_passphrase.ok().flatten().as_deref() == Some(passphrase.as_str()));
    assert!(other_passphrase.is_err() && other_kind.is_err());
    assert!(denied_passphrase_write.is_err() && denied_passphrase_delete.is_err());
    assert!(found.ok().flatten().as_deref() == Some(secret.as_str()));
    assert!(other.is_err());
    assert!(denied_write.is_err() && denied_delete.is_err());
}
