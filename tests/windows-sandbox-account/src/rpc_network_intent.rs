//! Fixed RPC_UM account-block intent. No caller-selected layer or descriptor.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcNetworkIntent {
    pub version: u32,
    pub fixture_id: Uuid,
    pub account_sid: String,
    pub filter_key: Uuid,
}
impl RpcNetworkIntent {
    pub fn validate(
        &self,
        fixture: Uuid,
        expected_account: &str,
        existing_keys: &[Uuid],
    ) -> Result<(), String> {
        let canonical = self
            .account_sid
            .strip_prefix("S-1-5-21-")
            .is_some_and(|tail| {
                let parts: Vec<_> = tail.split('-').collect();
                parts.len() == 4
                    && parts[3] != "0"
                    && parts.iter().all(|part| {
                        part.parse::<u32>()
                            .is_ok_and(|value| value.to_string() == *part)
                    })
            });
        if self.version != 1
            || fixture.is_nil()
            || self.fixture_id != fixture
            || !canonical
            || self.account_sid != expected_account
            || self.filter_key.is_nil()
            || existing_keys.contains(&self.filter_key)
            || !matches!(existing_keys.len(), 4 | 8)
            || existing_keys
                .iter()
                .enumerate()
                .any(|(index, key)| key.is_nil() || existing_keys[..index].contains(key))
        {
            return Err("RPC account block intent identity or independent key invalid".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rpc_block_cannot_be_global_or_replace_existing_identity_rules() {
        let fixture = Uuid::new_v4();
        let account = "S-1-5-21-1-2-3-1001";
        let keys: [Uuid; 8] = std::array::from_fn(|_| Uuid::new_v4());
        let intent = RpcNetworkIntent {
            version: 1,
            fixture_id: fixture,
            account_sid: account.into(),
            filter_key: Uuid::new_v4(),
        };
        intent.validate(fixture, account, &keys).unwrap();
        for key in keys.into_iter().chain([Uuid::nil()]) {
            let mut changed = intent.clone();
            changed.filter_key = key;
            assert!(changed.validate(fixture, account, &keys).is_err());
        }
        for sid in [
            "",
            "S-1-5-18",
            "S-1-5-21-1-2-3-0",
            "S-1-5-21-01-2-3-1001",
            "S-1-5-21-1-2-3-4294967296",
        ] {
            let mut changed = intent.clone();
            changed.account_sid = sid.into();
            assert!(changed.validate(fixture, sid, &keys).is_err());
        }
        assert!(intent.validate(Uuid::new_v4(), account, &keys).is_err());
        assert!(intent
            .validate(fixture, "S-1-5-21-1-2-3-1002", &keys)
            .is_err());
        assert!(intent.validate(fixture, account, &[]).is_err());
        for count in [5, 6, 7] {
            assert!(intent.validate(fixture, account, &keys[..count]).is_err());
        }
        let mut value = serde_json::to_value(&intent).unwrap();
        value["descriptor"] = serde_json::json!("D:(A;;CC;;;WD)");
        assert!(serde_json::from_value::<RpcNetworkIntent>(value).is_err());
    }
}
