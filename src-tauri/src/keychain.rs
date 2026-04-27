use keyring::Entry;
use log::{debug, info, warn};

const SERVICE_NAME: &str = "com.termbridge";

fn entry_key(profile_id: &str) -> String {
    format!("com.termbridge.password.{profile_id}")
}

pub(crate) fn set_password(profile_id: &str, password: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &entry_key(profile_id))
        .map_err(|e| format!("failed to create keyring entry: {e}"))?;
    entry
        .set_password(password)
        .map_err(|e| format!("failed to store password in keychain: {e}"))?;
    debug!("Stored password in keychain for profile {profile_id}");
    Ok(())
}

pub(crate) fn get_password(profile_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, &entry_key(profile_id))
        .map_err(|e| format!("failed to create keyring entry: {e}"))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to retrieve password from keychain: {e}")),
    }
}

pub(crate) fn delete_password(profile_id: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &entry_key(profile_id))
        .map_err(|e| format!("failed to create keyring entry: {e}"))?;
    match entry.delete_password() {
        Ok(()) => {
            debug!("Deleted password from keychain for profile {profile_id}");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete password from keychain: {e}")),
    }
}

pub(crate) fn migrate_passwords(
    profiles: &[(String, String)],
) -> Vec<(String, bool)> {
    let mut results = Vec::new();
    for (profile_id, password) in profiles {
        if password.is_empty() {
            continue;
        }
        match set_password(profile_id, password) {
            Ok(()) => {
                info!("Migrated password for profile {profile_id}");
                results.push((profile_id.clone(), true));
            }
            Err(e) => {
                warn!("Failed to migrate password for {profile_id}: {e}");
                results.push((profile_id.clone(), false));
            }
        }
    }
    let success_count = results.iter().filter(|(_, ok)| *ok).count();
    info!("Migrated {success_count}/{} passwords to keychain", results.len());
    results
}
