use log::debug;
use std::sync::{Arc, OnceLock};

#[cfg(any(target_os = "macos", test))]
use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::HashMap;
#[cfg(any(target_os = "macos", test))]
use std::sync::Mutex;

/// Initializes the platform's native credential store as the keyring-core
/// default store. Runs once; the result is cached so a permanent failure
/// (e.g. no Secret Service on a headless Linux box) is reported consistently
/// and callers consistently fail closed instead of silently persisting secrets
/// outside the native credential store.
fn ensure_native_store() -> Result<(), String> {
    static RESULT: OnceLock<Result<(), String>> = OnceLock::new();
    RESULT
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            #[cfg(target_os = "windows")]
            let store = windows_native_keyring_store::Store::new();
            #[cfg(any(target_os = "linux", target_os = "freebsd"))]
            let store = dbus_secret_service_keyring_store::Store::new();
            #[cfg(not(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "freebsd"
            )))]
            let store: Result<Arc<keyring_core::CredentialStore>, keyring_core::Error> =
                Err(keyring_core::Error::NotSupportedByStore(
                    "no native credential store for this platform".to_string(),
                ));
            keyring_core::set_default_store(store.map_err(|e| format!("keyring store init: {e}"))?);
            Ok(())
        })
        .clone()
}

pub(crate) const KEY_SERVICE: &str = "com.shellspan.key";
pub(crate) const PROFILE_PASSWORD_SERVICE: &str = "com.shellspan.profile-password";
pub(crate) const PROFILE_SECRET_SERVICE: &str = "com.shellspan.profile-secret";

const fn credential_service_for_mode(
    production: &'static str,
    development: &'static str,
    development_mode: bool,
) -> &'static str {
    if development_mode {
        development
    } else {
        production
    }
}

const KEY_CREDENTIAL_SERVICE: &str =
    credential_service_for_mode(KEY_SERVICE, "com.shellspan.dev.key", cfg!(debug_assertions));
const PROFILE_PASSWORD_CREDENTIAL_SERVICE: &str = credential_service_for_mode(
    PROFILE_PASSWORD_SERVICE,
    "com.shellspan.dev.profile-password",
    cfg!(debug_assertions),
);
const PROFILE_SECRET_CREDENTIAL_SERVICE: &str = credential_service_for_mode(
    PROFILE_SECRET_SERVICE,
    "com.shellspan.dev.profile-secret",
    cfg!(debug_assertions),
);
pub(crate) const AI_KEY_SERVICE: &str = credential_service_for_mode(
    "com.shellspan.ai-provider",
    "com.shellspan.dev.ai-provider",
    cfg!(debug_assertions),
);
pub(crate) const MCP_CREDENTIAL_SERVICE: &str = credential_service_for_mode(
    "com.shellspan.mcp",
    "com.shellspan.dev.mcp",
    cfg!(debug_assertions),
);

/// macOS Keychain authorizes access per item. Keeping every ShellSpan secret in
/// one item means the user authorizes ShellSpan once while the logical
/// service/account pairs remain isolated inside the vault payload.
#[cfg(any(target_os = "macos", test))]
const CREDENTIAL_VAULT_SERVICE: &str = credential_service_for_mode(
    "com.shellspan.credential-vault",
    "com.shellspan.dev.credential-vault",
    cfg!(debug_assertions),
);
#[cfg(any(target_os = "macos", test))]
const CREDENTIAL_VAULT_ACCOUNT: &str =
    credential_service_for_mode("shellspan-v2", "shellspan-dev-v2", cfg!(debug_assertions));
#[cfg(any(target_os = "macos", test))]
const CREDENTIAL_VAULT_VERSION: u32 = 2;

/// Kinds of per-profile secrets other than the main login password.
///
/// The main password keeps using [`PROFILE_PASSWORD_SERVICE`] keyed by the
/// bare profile id; these secrets live in [`PROFILE_SECRET_SERVICE`] keyed by
/// `{profile_id}:{suffix}` so one profile can hold several secrets without
/// collisions.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProfileSecretKind {
    /// Passphrase of the profile's own private key.
    Passphrase,
    /// Password of the jump host (password auth).
    JumpPassword,
    /// Passphrase of the jump host's private key.
    JumpPassphrase,
}

impl ProfileSecretKind {
    fn suffix(self) -> &'static str {
        match self {
            ProfileSecretKind::Passphrase => "passphrase",
            ProfileSecretKind::JumpPassword => "jump-password",
            ProfileSecretKind::JumpPassphrase => "jump-passphrase",
        }
    }

    fn key_for(self, profile_id: &str) -> String {
        format!("{profile_id}:{}", self.suffix())
    }
}

/// Abstraction over credential storage backends.
trait CredentialBackend: Send + Sync {
    fn set_credential(&self, service: &str, key: &str, value: &str) -> Result<(), String>;
    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String>;
    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String>;
}

// ---------------------------------------------------------------------------
// Native OS-level keychain backend (macOS Keychain / Windows Credential
// Manager / Linux Secret Service) via `keyring-core` plus the per-platform
// store crates.
// ---------------------------------------------------------------------------

struct NativeKeychainBackend;

/// A single-item credential vault used on macOS.
///
/// Windows keeps individual credentials because Credential Manager imposes a
/// small per-item blob limit. Linux keeps the native Secret Service layout.
/// The wrapper is also compiled for tests so its isolation semantics can be
/// exercised without touching the real Keychain.
#[cfg(any(target_os = "macos", test))]
struct VaultCredentialBackend {
    inner: Arc<dyn CredentialBackend>,
    operation_lock: Arc<Mutex<()>>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialVault {
    version: u32,
    entries: BTreeMap<String, BTreeMap<String, String>>,
}

#[cfg(any(target_os = "macos", test))]
impl Default for CredentialVault {
    fn default() -> Self {
        Self {
            version: CREDENTIAL_VAULT_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
impl CredentialVault {
    fn get(&self, service: &str, key: &str) -> Option<&str> {
        self.entries
            .get(service)
            .and_then(|entries| entries.get(key))
            .map(String::as_str)
    }

    fn insert(&mut self, service: &str, key: &str, value: &str) {
        self.entries
            .entry(service.to_string())
            .or_default()
            .insert(key.to_string(), value.to_string());
    }

    fn remove(&mut self, service: &str, key: &str) {
        if let Some(entries) = self.entries.get_mut(service) {
            entries.remove(key);
            if entries.is_empty() {
                self.entries.remove(service);
            }
        }
    }
}

#[cfg(any(target_os = "macos", test))]
impl VaultCredentialBackend {
    fn new(inner: Arc<dyn CredentialBackend>, operation_lock: Arc<Mutex<()>>) -> Self {
        Self {
            inner,
            operation_lock,
        }
    }

    fn validate_logical_specifier(service: &str, key: &str) -> Result<(), String> {
        if service.is_empty() {
            return Err("credential service cannot be empty".to_string());
        }
        if key.is_empty() {
            return Err("credential key cannot be empty".to_string());
        }
        if service == CREDENTIAL_VAULT_SERVICE && key == CREDENTIAL_VAULT_ACCOUNT {
            return Err("credential identifier is reserved for the ShellSpan vault".to_string());
        }
        Ok(())
    }

    fn load_vault(&self) -> Result<CredentialVault, String> {
        let Some(payload) = self
            .inner
            .get_credential(CREDENTIAL_VAULT_SERVICE, CREDENTIAL_VAULT_ACCOUNT)?
        else {
            return Ok(CredentialVault::default());
        };
        let vault: CredentialVault = serde_json::from_str(&payload)
            .map_err(|e| format!("credential vault is invalid: {e}"))?;
        if vault.version != CREDENTIAL_VAULT_VERSION {
            return Err(format!(
                "unsupported credential vault version: {}",
                vault.version
            ));
        }
        Ok(vault)
    }

    fn save_vault(&self, vault: &CredentialVault) -> Result<(), String> {
        let payload = serde_json::to_string(vault)
            .map_err(|e| format!("credential vault serialization failed: {e}"))?;
        self.inner
            .set_credential(CREDENTIAL_VAULT_SERVICE, CREDENTIAL_VAULT_ACCOUNT, &payload)
    }

    fn lock_operations(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.operation_lock
            .lock()
            .map_err(|_| "credential vault is unavailable".to_string())
    }
}

#[cfg(any(target_os = "macos", test))]
impl CredentialBackend for VaultCredentialBackend {
    fn set_credential(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
        Self::validate_logical_specifier(service, key)?;
        let _guard = self.lock_operations()?;
        let mut vault = self.load_vault()?;
        vault.insert(service, key, value);
        self.save_vault(&vault)
    }

    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        Self::validate_logical_specifier(service, key)?;
        let _guard = self.lock_operations()?;
        let vault = self.load_vault()?;
        Ok(vault.get(service, key).map(str::to_string))
    }

    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        Self::validate_logical_specifier(service, key)?;
        let _guard = self.lock_operations()?;
        let mut vault = self.load_vault()?;
        vault.remove(service, key);
        self.save_vault(&vault)
    }
}

#[cfg(target_os = "macos")]
fn shared_native_vault_lock() -> Arc<Mutex<()>> {
    static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    Arc::clone(LOCK.get_or_init(|| Arc::new(Mutex::new(()))))
}

impl CredentialBackend for NativeKeychainBackend {
    fn set_credential(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            macos_keychain::set_generic_password_with_current_app_access(service, key, value)?;
            debug!("Stored credential in OS keychain service={service} key={key}");
            Ok(())
        }

        #[cfg(not(target_os = "macos"))]
        {
            ensure_native_store()?;
            let entry =
                keyring_core::Entry::new(service, key).map_err(|e| format!("keyring new: {e}"))?;
            entry
                .set_password(value)
                .map_err(|e| format!("keyring set_password: {e}"))?;
            debug!("Stored credential in OS keychain service={service} key={key}");
            Ok(())
        }
    }

    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        {
            match macos_keychain::get_generic_password(service, key) {
                Ok(Some(password)) => {
                    debug!("Loaded credential from OS keychain service={service} key={key}");
                    Ok(Some(password))
                }
                Ok(None) => {
                    debug!("No credential in OS keychain for service={service} key={key}");
                    Ok(None)
                }
                Err(e) => Err(format!("keyring get_password: {e}")),
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            ensure_native_store()?;
            let entry =
                keyring_core::Entry::new(service, key).map_err(|e| format!("keyring new: {e}"))?;
            match entry.get_password() {
                Ok(password) => {
                    debug!("Loaded credential from OS keychain service={service} key={key}");
                    Ok(Some(password))
                }
                Err(keyring_core::Error::NoEntry) => {
                    debug!("No credential in OS keychain for service={service} key={key}");
                    Ok(None)
                }
                Err(e) => Err(format!("keyring get_password: {e}")),
            }
        }
    }

    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        ensure_native_store()?;
        let entry =
            keyring_core::Entry::new(service, key).map_err(|e| format!("keyring new: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => {
                debug!("Deleted credential from OS keychain service={service} key={key}");
                Ok(())
            }
            Err(keyring_core::Error::NoEntry) => {
                debug!("No credential to delete in OS keychain for service={service} key={key}");
                Ok(())
            }
            Err(e) => Err(format!("keyring delete_credential: {e}")),
        }
    }
}

/// Process-local credential storage for tests that must exercise the real SSH
/// connection path without writing fixture secrets to the user's keychain.
#[cfg(test)]
#[derive(Default)]
struct InMemoryCredentialBackend {
    credentials: Mutex<HashMap<(String, String), String>>,
}

#[cfg(test)]
impl CredentialBackend for InMemoryCredentialBackend {
    fn set_credential(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
        self.credentials
            .lock()
            .map_err(|_| "test credential store is unavailable".to_string())?
            .insert((service.to_string(), key.to_string()), value.to_string());
        Ok(())
    }

    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        Ok(self
            .credentials
            .lock()
            .map_err(|_| "test credential store is unavailable".to_string())?
            .get(&(service.to_string(), key.to_string()))
            .cloned())
    }

    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        self.credentials
            .lock()
            .map_err(|_| "test credential store is unavailable".to_string())?
            .remove(&(service.to_string(), key.to_string()));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Public credential manager
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub(crate) struct CredentialManager {
    backend: Arc<dyn CredentialBackend>,
}

impl CredentialManager {
    /// Creates a credential manager that stores secrets in the OS-level
    /// keychain (macOS Keychain, Windows Credential Manager, or Linux Secret
    /// Service). Operations fail closed when the native store is unavailable.
    pub(crate) fn new() -> Self {
        #[cfg(target_os = "macos")]
        let backend: Arc<dyn CredentialBackend> = Arc::new(VaultCredentialBackend::new(
            Arc::new(NativeKeychainBackend),
            shared_native_vault_lock(),
        ));
        #[cfg(not(target_os = "macos"))]
        let backend: Arc<dyn CredentialBackend> = Arc::new(NativeKeychainBackend);

        Self { backend }
    }

    #[cfg(test)]
    fn with_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self { backend }
    }

    #[cfg(test)]
    fn with_vault_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self::with_backend(Arc::new(VaultCredentialBackend::new(
            backend,
            Arc::new(Mutex::new(())),
        )))
    }

    #[cfg(test)]
    pub(crate) fn in_memory_for_tests() -> Self {
        Self::with_backend(Arc::new(InMemoryCredentialBackend::default()))
    }

    // --- Generic credentials ---

    pub(crate) fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.backend.set_credential(service, key, value)
    }

    pub(crate) fn get_credential(
        &self,
        service: &str,
        key: &str,
    ) -> Result<Option<String>, String> {
        self.backend.get_credential(service, key)
    }

    pub(crate) fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        self.backend.delete_credential(service, key)
    }

    // --- Key credentials ---

    pub(crate) fn store_key_credential(&self, key_id: &str, value: &str) -> Result<(), String> {
        self.set_credential(KEY_CREDENTIAL_SERVICE, key_id, value)
    }

    pub(crate) fn retrieve_key_credential(&self, key_id: &str) -> Result<Option<String>, String> {
        self.get_credential(KEY_CREDENTIAL_SERVICE, key_id)
    }

    pub(crate) fn delete_key_credential(&self, key_id: &str) -> Result<(), String> {
        self.delete_credential(KEY_CREDENTIAL_SERVICE, key_id)
    }

    // --- Profile passwords ---

    pub(crate) fn store_profile_password(
        &self,
        profile_id: &str,
        password: &str,
    ) -> Result<(), String> {
        self.set_credential(PROFILE_PASSWORD_CREDENTIAL_SERVICE, profile_id, password)
    }

    pub(crate) fn retrieve_profile_password(
        &self,
        profile_id: &str,
    ) -> Result<Option<String>, String> {
        self.get_credential(PROFILE_PASSWORD_CREDENTIAL_SERVICE, profile_id)
    }

    pub(crate) fn delete_profile_password(&self, profile_id: &str) -> Result<(), String> {
        self.delete_credential(PROFILE_PASSWORD_CREDENTIAL_SERVICE, profile_id)
    }

    // --- Profile secrets (key passphrases, jump-host credentials) ---

    pub(crate) fn store_profile_secret(
        &self,
        profile_id: &str,
        kind: ProfileSecretKind,
        value: &str,
    ) -> Result<(), String> {
        self.set_credential(
            PROFILE_SECRET_CREDENTIAL_SERVICE,
            &kind.key_for(profile_id),
            value,
        )
    }

    pub(crate) fn retrieve_profile_secret(
        &self,
        profile_id: &str,
        kind: ProfileSecretKind,
    ) -> Result<Option<String>, String> {
        self.get_credential(PROFILE_SECRET_CREDENTIAL_SERVICE, &kind.key_for(profile_id))
    }

    /// Deletes every secret belonging to a profile: the main password plus
    /// all [`ProfileSecretKind`] entries. Best-effort per entry — a failure
    /// on one kind does not prevent deleting the others; the first error is
    /// returned after all deletes were attempted.
    pub(crate) fn delete_all_profile_secrets(&self, profile_id: &str) -> Result<(), String> {
        let mut first_error = self.delete_profile_password(profile_id).err();
        for kind in [
            ProfileSecretKind::Passphrase,
            ProfileSecretKind::JumpPassword,
            ProfileSecretKind::JumpPassphrase,
        ] {
            if let Err(e) = self.delete_profile_secret(profile_id, kind) {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    pub(crate) fn delete_profile_secret(
        &self,
        profile_id: &str,
        kind: ProfileSecretKind,
    ) -> Result<(), String> {
        self.delete_credential(PROFILE_SECRET_CREDENTIAL_SERVICE, &kind.key_for(profile_id))
    }
}

#[cfg(target_os = "macos")]
mod macos_keychain {
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::string::CFString;
    use core_foundation_sys::array::{kCFTypeArrayCallBacks, CFArrayCreate, CFArrayRef};
    use core_foundation_sys::base::{kCFAllocatorDefault, CFTypeRef, OSStatus};
    use core_foundation_sys::string::CFStringRef;
    use security_framework::base::Error;
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
    use security_framework::os::macos::passwords::find_generic_password;
    use security_framework_sys::base::{
        errSecDuplicateItem, errSecItemNotFound, errSecParam, errSecSuccess, SecAccessRef,
        SecKeychainAttribute, SecKeychainAttributeList, SecKeychainItemRef, SecKeychainRef,
    };
    use std::ffi::CString;
    use std::os::raw::c_void;
    use std::path::{Path, PathBuf};
    use std::ptr;

    const ITEM_CLASS_GENERIC_PASSWORD: u32 = four_char_code(*b"genp");
    const ATTR_ACCOUNT: u32 = four_char_code(*b"acct");
    const ATTR_SERVICE: u32 = four_char_code(*b"svce");

    const fn four_char_code(value: [u8; 4]) -> u32 {
        ((value[0] as u32) << 24)
            | ((value[1] as u32) << 16)
            | ((value[2] as u32) << 8)
            | (value[3] as u32)
    }

    extern "C" {
        fn SecAccessCreate(
            descriptor: CFStringRef,
            trustedlist: CFArrayRef,
            access_ref: *mut SecAccessRef,
        ) -> OSStatus;

        fn SecKeychainItemCreateFromContent(
            item_class: u32,
            attr_list: *mut SecKeychainAttributeList,
            length: u32,
            data: *const c_void,
            keychain_ref: SecKeychainRef,
            initial_access: SecAccessRef,
            item_ref: *mut SecKeychainItemRef,
        ) -> OSStatus;

        fn SecTrustedApplicationCreateFromPath(path: *const i8, app: *mut CFTypeRef) -> OSStatus;
    }

    pub(super) fn get_generic_password(
        service: &str,
        account: &str,
    ) -> Result<Option<String>, String> {
        validate_specifier(service, "service")?;
        validate_specifier(account, "account")?;

        let keychain = user_keychain()?;
        match find_generic_password(Some(&[keychain]), service, account) {
            Ok((password, _item)) => String::from_utf8(password.as_ref().to_vec())
                .map(Some)
                .map_err(|e| format!("macOS keychain password is not utf-8: {e}")),
            Err(error) if error.code() == errSecItemNotFound => Ok(None),
            Err(error) => Err(format!("macOS keychain find: {error}")),
        }
    }

    pub(super) fn set_generic_password_with_current_app_access(
        service: &str,
        account: &str,
        password: &str,
    ) -> Result<(), String> {
        validate_specifier(service, "service")?;
        validate_specifier(account, "account")?;

        let keychain = user_keychain()?;
        match find_generic_password(Some(std::slice::from_ref(&keychain)), service, account) {
            Ok((_old_password, mut item)) => item
                .set_password(password.as_bytes())
                .map_err(|e| format!("macOS keychain update password: {e}")),
            Err(error) if error.code() == errSecItemNotFound => {
                match add_with_current_app_access(&keychain, service, account, password.as_bytes())
                {
                    Ok(()) => Ok(()),
                    Err(error) if error.code() == errSecDuplicateItem => {
                        update_existing_password(&keychain, service, account, password)
                    }
                    Err(error) => Err(format!("macOS keychain create: {error}")),
                }
            }
            Err(error) => Err(format!("macOS keychain find existing item: {error}")),
        }
    }

    fn validate_specifier(value: &str, label: &str) -> Result<(), String> {
        if value.is_empty() {
            Err(format!("macOS keychain {label} cannot be empty"))
        } else {
            Ok(())
        }
    }

    fn user_keychain() -> Result<SecKeychain, String> {
        SecKeychain::default_for_domain(SecPreferencesDomain::User)
            .map_err(|e| format!("macOS keychain open login keychain: {e}"))
    }

    fn update_existing_password(
        keychain: &SecKeychain,
        service: &str,
        account: &str,
        password: &str,
    ) -> Result<(), String> {
        match find_generic_password(Some(std::slice::from_ref(keychain)), service, account) {
            Ok((_old_password, mut item)) => item
                .set_password(password.as_bytes())
                .map_err(|e| format!("macOS keychain update password: {e}")),
            Err(error) => Err(format!("macOS keychain update existing item: {error}")),
        }
    }

    fn add_with_current_app_access(
        keychain: &SecKeychain,
        service: &str,
        account: &str,
        password: &[u8],
    ) -> Result<(), Error> {
        let mut service_bytes = service.as_bytes().to_vec();
        let mut account_bytes = account.as_bytes().to_vec();
        let mut attrs = [
            SecKeychainAttribute {
                tag: ATTR_SERVICE,
                length: service_bytes.len() as u32,
                data: service_bytes.as_mut_ptr().cast(),
            },
            SecKeychainAttribute {
                tag: ATTR_ACCOUNT,
                length: account_bytes.len() as u32,
                data: account_bytes.as_mut_ptr().cast(),
            },
        ];
        let mut attr_list = SecKeychainAttributeList {
            count: attrs.len() as u32,
            attr: attrs.as_mut_ptr(),
        };
        let mut item = ptr::null_mut();

        let result = with_current_app_access(|access| unsafe {
            cvt_status(SecKeychainItemCreateFromContent(
                ITEM_CLASS_GENERIC_PASSWORD,
                &mut attr_list,
                password.len() as u32,
                password.as_ptr().cast(),
                keychain.as_concrete_TypeRef(),
                access,
                &mut item,
            ))
        });

        unsafe {
            if !item.is_null() {
                CFRelease(item.cast());
            }
        }

        result
    }

    fn with_current_app_access<T>(
        f: impl FnOnce(SecAccessRef) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let descriptor = CFString::from_static_string("ShellSpan");
        let trusted_list = TrustedApplicationList::current_app()?;
        let mut access = ptr::null_mut();
        unsafe {
            cvt_status(SecAccessCreate(
                descriptor.as_concrete_TypeRef(),
                trusted_list.array,
                &mut access,
            ))?;
        }

        let result = f(access);

        unsafe {
            if !access.is_null() {
                CFRelease(access.cast());
            }
        }

        result
    }

    struct TrustedApplicationList {
        app: CFTypeRef,
        array: CFArrayRef,
    }

    impl TrustedApplicationList {
        fn current_app() -> Result<Self, Error> {
            let path = trusted_app_path().ok_or_else(|| Error::from_code(errSecParam))?;
            let path = CString::new(path.to_string_lossy().as_bytes())
                .map_err(|_| Error::from_code(errSecParam))?;
            let mut app = ptr::null();
            unsafe {
                cvt_status(SecTrustedApplicationCreateFromPath(path.as_ptr(), &mut app))?;
                let values = [app];
                let array = CFArrayCreate(
                    kCFAllocatorDefault,
                    values.as_ptr(),
                    values.len() as isize,
                    &kCFTypeArrayCallBacks,
                );
                if array.is_null() {
                    CFRelease(app);
                    return Err(Error::from_code(errSecParam));
                }
                Ok(Self { app, array })
            }
        }
    }

    impl Drop for TrustedApplicationList {
        fn drop(&mut self) {
            unsafe {
                CFRelease(self.array.cast_mut().cast());
                CFRelease(self.app);
            }
        }
    }

    fn trusted_app_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        find_app_bundle(&exe).or(Some(exe))
    }

    fn find_app_bundle(path: &Path) -> Option<PathBuf> {
        path.ancestors()
            .find(|ancestor| ancestor.extension().is_some_and(|ext| ext == "app"))
            .map(Path::to_path_buf)
    }

    fn cvt_status(status: OSStatus) -> Result<(), Error> {
        if status == errSecSuccess {
            Ok(())
        } else {
            Err(Error::from_code(status))
        }
    }
}

#[cfg(test)]
mod tests {
    include!("tests/keychain.rs");
}
