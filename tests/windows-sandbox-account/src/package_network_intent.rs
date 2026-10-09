//! Journal intent for four additional package blocks; never replaces account blocks.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageNetworkIntent {
    pub version: u32,
    pub fixture_id: Uuid,
    pub package_sid: String,
    /// Fixed order: CONNECT v4/v6, RECV_ACCEPT v4/v6.
    pub filter_keys: [Uuid; 4],
}

pub fn expected_package_sid(fixture: Uuid) -> Result<String, String> {
    if fixture.is_nil() {
        return Err("package identity requires nonnil fixture".into());
    }
    let name: Vec<u16> = format!("ShellSpan-candidate-{}", fixture.simple())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut raw = std::ptr::null_mut();
    let result = unsafe {
        windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName(
            name.as_ptr(),
            &mut raw,
        )
    };
    struct Sid(windows_sys::Win32::Security::PSID);
    impl Drop for Sid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { windows_sys::Win32::Security::FreeSid(self.0) };
            }
        }
    }
    let sid = Sid(raw);
    if result < 0 || sid.0.is_null() {
        return Err(format!(
            "derive fixed package identity: HRESULT {result:#x}"
        ));
    }
    unsafe { crate::appcontainer_probe::sid_text(sid.0) }
}
impl PackageNetworkIntent {
    /// The expected identity must come from the protected launch receipt and
    /// subsequently be checked against the actual primary token before Resume.
    pub fn validate(
        &self,
        fixture: Uuid,
        expected_package: &str,
        account_keys: &[Uuid; 4],
    ) -> Result<(), String> {
        let canonical = self
            .package_sid
            .strip_prefix("S-1-15-2-")
            .is_some_and(|tail| {
                let parts: Vec<_> = tail.split('-').collect();
                parts.len() == 7
                    && parts.iter().all(|part| {
                        part.parse::<u32>()
                            .is_ok_and(|value| value.to_string() == *part)
                    })
            });
        if self.version != 1
            || fixture.is_nil()
            || self.fixture_id != fixture
            || self.package_sid != expected_package
            || !canonical
            || self.filter_keys.iter().enumerate().any(|(index, key)| {
                key.is_nil()
                    || self.filter_keys[..index].contains(key)
                    || account_keys.contains(key)
            })
            || account_keys
                .iter()
                .enumerate()
                .any(|(index, key)| key.is_nil() || account_keys[..index].contains(key))
        {
            return Err("package network intent identity or independent keys invalid".into());
        }
        if self.package_sid != expected_package_sid(fixture)? {
            return Err("package network intent differs from fixed fixture moniker".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_blocks_bind_fixture_and_cannot_replace_account_block_keys() {
        let fixture = Uuid::new_v4();
        let derived = expected_package_sid(fixture).unwrap();
        let package = derived.as_str();
        let account = std::array::from_fn(|_| Uuid::new_v4());
        let intent = PackageNetworkIntent {
            version: 1,
            fixture_id: fixture,
            package_sid: package.into(),
            filter_keys: std::array::from_fn(|_| Uuid::new_v4()),
        };
        intent.validate(fixture, package, &account).unwrap();
        let mut substituted = intent.clone();
        substituted.package_sid = expected_package_sid(Uuid::new_v4()).unwrap();
        assert!(substituted
            .validate(fixture, &substituted.package_sid, &account)
            .is_err());
        assert!(intent.validate(Uuid::new_v4(), package, &account).is_err());
        assert!(intent
            .validate(fixture, "S-1-15-2-7-6-5-4-3-2-1", &account)
            .is_err());
        for index in 0..4 {
            for key in [
                Uuid::nil(),
                account[index],
                intent.filter_keys[(index + 1) % 4],
            ] {
                let mut changed = intent.clone();
                changed.filter_keys[index] = key;
                assert!(changed.validate(fixture, package, &account).is_err());
            }
        }
        for package in [
            "S-1-15-2-1",
            "S-1-15-2-01-2-3-4-5-6-7",
            "S-1-15-3-1-2-3-4-5-6-7",
        ] {
            let mut changed = intent.clone();
            changed.package_sid = package.into();
            assert!(changed.validate(fixture, package, &account).is_err());
        }
        let mut value = serde_json::to_value(&intent).unwrap();
        value["arbitrary_layer"] = serde_json::json!("unknown");
        assert!(serde_json::from_value::<PackageNetworkIntent>(value).is_err());
    }
}
