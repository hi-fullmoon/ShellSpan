//! A cleanup-only capsule. It contains no command or execution grant and is
//! stored only through CredentialManager, never in the ordinary journal.
use super::*;
use crate::keychain::ProfileSecretKind;
use crate::models::AuthMethod;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteCleanupCapsule {
    python: String,
    host_key: String,
    controller_sha256: String,
    profile_id: String,
    connection: CleanupConnection,
    root: String,
    home: String,
    temp_base: String,
    uid: u32,
    job_id: String,
    digest: String,
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupConnection {
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    keychain_key_id: Option<String>,
}

impl RemoteSeatbeltJob {
    pub(crate) fn cleanup_capsule(&self) -> Result<RemoteCleanupCapsule, String> {
        let connection = self.connection.clone();
        let profile_id = self
            .contract
            .target
            .profile_id
            .clone()
            .ok_or("directOwnershipUnavailable")?;
        if connection.jump_host.is_some()
            || connection.auth_method == AuthMethod::Key && connection.keychain_key_id.is_none()
        {
            return Err("directOwnershipUnavailable".into());
        }
        let connection = CleanupConnection {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            auth_method: connection.auth_method,
            keychain_key_id: connection.keychain_key_id,
        };
        Ok(RemoteCleanupCapsule {
            python: self.verification.python.clone(),
            host_key: self.verification.host_key.clone(),
            controller_sha256: hex::encode(Sha256::digest(include_bytes!("remote_seatbelt.py"))),
            profile_id,
            connection,
            root: self.verification.facts.root.clone(),
            home: self.verification.facts.home.clone(),
            temp_base: self.verification.facts.temp_base.clone(),
            uid: self.verification.facts.uid,
            job_id: self.request["jobId"]
                .as_str()
                .ok_or("directOwnershipUnavailable")?
                .into(),
            digest: self.request["digest"]
                .as_str()
                .ok_or("directOwnershipUnavailable")?
                .into(),
            token: self.secret(),
        })
    }
}

impl RemoteCleanupCapsule {
    fn control(
        &self,
        mode: &str,
        credentials: &CredentialManager,
        known_hosts: &Path,
    ) -> Result<Value, String> {
        if !matches!(mode, "status" | "stop" | "cleanup")
            || self.controller_sha256
                != hex::encode(Sha256::digest(include_bytes!("remote_seatbelt.py")))
            || self.uid == 0
        {
            return Err("directOwnershipInvalid".into());
        }
        Uuid::parse_str(&self.job_id).map_err(|_| "directOwnershipInvalid")?;
        let key: [u8; 32] = hex::decode(&self.token)
            .map_err(|_| "directOwnershipInvalid")?
            .try_into()
            .map_err(|_| "directOwnershipInvalid")?;
        let mut connection = RemoteConnectionRequest {
            host: self.connection.host.clone(),
            port: self.connection.port,
            username: self.connection.username.clone(),
            auth_method: self.connection.auth_method,
            keychain_key_id: self.connection.keychain_key_id.clone(),
            password: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        match connection.auth_method {
            AuthMethod::Password => {
                connection.password = credentials.retrieve_profile_password(&self.profile_id)?;
                if connection.password.is_none() {
                    return Err("directOwnershipUnavailable".into());
                }
            }
            AuthMethod::Key => {
                connection.passphrase = credentials
                    .retrieve_profile_secret(&self.profile_id, ProfileSecretKind::Passphrase)?;
                crate::commands::resolve_keychain_key_for_remote(credentials, &mut connection)?;
                if connection.private_key_data.is_none() {
                    return Err("directOwnershipUnavailable".into());
                }
            }
        }
        let request = json!({"mode":mode,"root":self.root,"home":self.home,"tempBase":self.temp_base,"uid":self.uid,
            "jobId":self.job_id,"digest":self.digest,"token":self.token,"signal":"kill"});
        let data = verify_receipt(
            fixed_json(
                &self.python,
                &request,
                &connection,
                known_hosts,
                &self.host_key,
                Duration::from_secs(4),
            )?,
            &key,
            &self.job_id,
        )?;
        if data["root"] != self.root || data["digest"] != self.digest {
            return Err("directOwnershipInvalid".into());
        }
        Ok(data)
    }

    pub(crate) fn reconcile(
        &self,
        credentials: &CredentialManager,
        known_hosts: &Path,
    ) -> Result<(), String> {
        let first = self.control("status", credentials, known_hosts)?;
        if first["controllerFinished"] != true {
            let _ = self.control("stop", credentials, known_hosts);
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let data = self.control("status", credentials, known_hosts)?;
            if data["controllerFinished"] == true && data["terminationConfirmed"] == true {
                let cleaned = self.control("cleanup", credentials, known_hosts)?;
                if cleaned["controllerFinished"] == true && cleaned["terminationConfirmed"] == true
                {
                    return Ok(());
                }
                return Err("directCleanupUnconfirmed".into());
            }
            if Instant::now() >= deadline {
                return Err("directCleanupUnconfirmed".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
