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
