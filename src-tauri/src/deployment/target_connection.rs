use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{
    AuthMethod, JumpHostConfig, ProfileAuthMethod, ProfileRow, RemoteConnectionRequest,
};

pub(crate) fn connection_for_profile(
    credentials: &CredentialManager,
    profile: &ProfileRow,
) -> Result<RemoteConnectionRequest, String> {
    let auth_method = match profile.auth_method {
        ProfileAuthMethod::Password => AuthMethod::Password,
        ProfileAuthMethod::Key => AuthMethod::Key,
    };
    let password = if auth_method == AuthMethod::Password {
        Some(
            credentials
                .retrieve_profile_password(&profile.id)?
                .ok_or_else(|| "profile password is unavailable".to_string())?,
        )
    } else {
        None
    };
    let passphrase = if auth_method == AuthMethod::Key {
        credentials.retrieve_profile_secret(&profile.id, ProfileSecretKind::Passphrase)?
    } else {
        None
    };
    let mut jump_host = profile
        .jump_host_config
        .as_deref()
        .map(serde_json::from_str::<JumpHostConfig>)
        .transpose()
        .map_err(|error| format!("stored jump-host configuration is invalid: {error}"))?;
    if let Some(jump) = &mut jump_host {
        match jump.auth_method {
            AuthMethod::Password => {
                jump.password = Some(
                    credentials
                        .retrieve_profile_secret(&profile.id, ProfileSecretKind::JumpPassword)?
                        .ok_or_else(|| "jump-host password is unavailable".to_string())?,
                );
            }
            AuthMethod::Key => {
                jump.passphrase = credentials
                    .retrieve_profile_secret(&profile.id, ProfileSecretKind::JumpPassphrase)?;
            }
        }
    }
    Ok(RemoteConnectionRequest {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth_method,
        password,
        keychain_key_id: profile.keychain_key_id.clone(),
        private_key_data: None,
        passphrase,
        jump_host,
    })
}
