use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use hmac::{Hmac, Mac};
use sha2_compat::Sha256;
use uuid::Uuid;

use crate::agent_runtime::{
    AgentCapabilityVerificationContextNative, AgentCapabilityVerificationFailureNative,
    AgentCapabilityVerifierNative, AgentEffectKindNative, VerifiedAgentCapabilityNative,
};

pub(crate) const MAX_CAPABILITY_TTL_MS: u64 = 5 * 60_000;
const MAX_CAPABILITY_USES: u16 = 32;
const MAX_CAPABILITY_RECORDS: usize = 1024;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub(crate) struct CapabilityIssueRequestNative {
    pub(crate) request_id: String,
    pub(crate) user_session_id: String,
    pub(crate) call_id: String,
    pub(crate) call_digest: String,
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) allowed_effects: Vec<AgentEffectKindNative>,
    pub(crate) target_ids: Vec<String>,
    pub(crate) ttl_ms: u64,
    pub(crate) max_uses: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IssuedCapabilityNative {
    pub(crate) capability_id: String,
    pub(crate) expires_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct CapabilityRecordNative {
    capability_id: String,
    request_id: String,
    user_session_id: String,
    allowed_call_ids: Vec<String>,
    call_digest: String,
    allowed_tools: Vec<String>,
    allowed_effects: Vec<AgentEffectKindNative>,
    target_ids: Vec<String>,
    not_before_unix_ms: u64,
    expires_at_unix_ms: u64,
    revoked: bool,
    uses: u16,
    max_uses: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapabilityStoreErrorNative {
    InvalidScope,
    InvalidTtl,
    InvalidUseLimit,
    Unknown,
    Revoked,
    Expired,
    Exhausted,
    Unavailable,
}

#[derive(Clone)]
pub(crate) struct NativeCapabilityStoreNative {
    signing_key: Arc<[u8; 32]>,
    records: Arc<Mutex<HashMap<String, CapabilityRecordNative>>>,
}

impl Default for NativeCapabilityStoreNative {
    fn default() -> Self {
        let mut key = [0_u8; 32];
        key[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        key[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        Self {
            signing_key: Arc::new(key),
            records: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl NativeCapabilityStoreNative {
    #[cfg(test)]
    fn with_signing_key(key: [u8; 32]) -> Self {
        Self {
            signing_key: Arc::new(key),
            records: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn issue(
        &self,
        request: CapabilityIssueRequestNative,
        now_unix_ms: u64,
    ) -> Result<IssuedCapabilityNative, CapabilityStoreErrorNative> {
        if request.request_id.is_empty()
            || request.user_session_id.is_empty()
            || request.call_id.is_empty()
            || request.call_digest.len() != 64
            || !request
                .call_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || request.allowed_tools.is_empty()
            || request.allowed_effects.is_empty()
            || request.target_ids.is_empty()
            || request.allowed_tools.iter().any(String::is_empty)
            || request.target_ids.iter().any(String::is_empty)
        {
            return Err(CapabilityStoreErrorNative::InvalidScope);
        }
        if request.ttl_ms == 0 || request.ttl_ms > MAX_CAPABILITY_TTL_MS {
            return Err(CapabilityStoreErrorNative::InvalidTtl);
        }
        if request.max_uses == 0 || request.max_uses > MAX_CAPABILITY_USES {
            return Err(CapabilityStoreErrorNative::InvalidUseLimit);
        }

        let nonce = Uuid::new_v4().simple().to_string();
        let mac = self.sign_nonce(&nonce);
        let capability_id = format!("cap-{nonce}-{mac}");
        let expires_at_unix_ms = now_unix_ms.saturating_add(request.ttl_ms);
        let record = CapabilityRecordNative {
            capability_id: capability_id.clone(),
            request_id: request.request_id,
            user_session_id: request.user_session_id,
            allowed_call_ids: vec![request.call_id],
            call_digest: request.call_digest,
            allowed_tools: request.allowed_tools,
            allowed_effects: request.allowed_effects,
            target_ids: request.target_ids,
            not_before_unix_ms: now_unix_ms,
            expires_at_unix_ms,
            revoked: false,
            uses: 0,
            max_uses: request.max_uses,
        };
        let mut records = self
            .records
            .lock()
            .map_err(|_| CapabilityStoreErrorNative::Unavailable)?;
        records.retain(|_, record| {
            !record.revoked
                && now_unix_ms < record.expires_at_unix_ms
                && record.uses < record.max_uses
        });
        if records.len() >= MAX_CAPABILITY_RECORDS {
            return Err(CapabilityStoreErrorNative::Unavailable);
        }
        records.insert(capability_id.clone(), record);
        Ok(IssuedCapabilityNative {
            capability_id,
            expires_at_unix_ms,
        })
    }

    pub(crate) fn revoke(&self, capability_id: &str) -> Result<(), CapabilityStoreErrorNative> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| CapabilityStoreErrorNative::Unavailable)?;
        let record = records
            .get_mut(capability_id)
            .ok_or(CapabilityStoreErrorNative::Unknown)?;
        record.revoked = true;
        Ok(())
    }

    pub(crate) fn consume(
        &self,
        capability_id: &str,
        now_unix_ms: u64,
    ) -> Result<(), CapabilityStoreErrorNative> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| CapabilityStoreErrorNative::Unavailable)?;
        let record = records
            .get_mut(capability_id)
            .ok_or(CapabilityStoreErrorNative::Unknown)?;
        if record.revoked {
            return Err(CapabilityStoreErrorNative::Revoked);
        }
        if now_unix_ms < record.not_before_unix_ms || now_unix_ms >= record.expires_at_unix_ms {
            return Err(CapabilityStoreErrorNative::Expired);
        }
        if record.uses >= record.max_uses {
            return Err(CapabilityStoreErrorNative::Exhausted);
        }
        record.uses += 1;
        Ok(())
    }

    pub(crate) fn verify_bound_call(
        &self,
        capability_id: &str,
        context: AgentCapabilityVerificationContextNative<'_>,
        call_digest: &str,
        now_unix_ms: u64,
    ) -> Result<VerifiedAgentCapabilityNative, AgentCapabilityVerificationFailureNative> {
        {
            let records = self
                .records
                .lock()
                .map_err(|_| AgentCapabilityVerificationFailureNative::Unknown)?;
            let record = records
                .get(capability_id)
                .ok_or(AgentCapabilityVerificationFailureNative::Unknown)?;
            if record.call_digest != call_digest {
                return Err(AgentCapabilityVerificationFailureNative::InvalidProof);
            }
        }
        self.verify(capability_id, context, now_unix_ms)
    }

    pub(crate) fn verify_bound_scope(
        &self,
        capability_id: &str,
        context: AgentCapabilityVerificationContextNative<'_>,
        call_digest: &str,
        tool_name: &str,
        effect: AgentEffectKindNative,
        now_unix_ms: u64,
    ) -> Result<VerifiedAgentCapabilityNative, AgentCapabilityVerificationFailureNative> {
        let verified = self.verify_bound_call(capability_id, context, call_digest, now_unix_ms)?;
        let records = self
            .records
            .lock()
            .map_err(|_| AgentCapabilityVerificationFailureNative::Unknown)?;
        let record = records
            .get(capability_id)
            .ok_or(AgentCapabilityVerificationFailureNative::Unknown)?;
        if !record
            .allowed_tools
            .iter()
            .any(|allowed| allowed == tool_name)
            || !record.allowed_effects.contains(&effect)
        {
            return Err(AgentCapabilityVerificationFailureNative::InvalidProof);
        }
        Ok(verified)
    }

    fn sign_nonce(&self, nonce: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(self.signing_key.as_ref())
            .expect("HMAC accepts a fixed 32-byte key");
        mac.update(b"shellspan-agent-capability-native\0");
        mac.update(nonce.as_bytes());
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn proof_is_valid(&self, capability_id: &str) -> bool {
        let Some(suffix) = capability_id.strip_prefix("cap-") else {
            return false;
        };
        let Some((nonce, claimed_mac)) = suffix.split_once('-') else {
            return false;
        };
        if nonce.len() != 32 || claimed_mac.len() != 64 {
            return false;
        }
        let Ok(claimed_bytes) = (0..claimed_mac.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&claimed_mac[index..index + 2], 16))
            .collect::<Result<Vec<_>, _>>()
        else {
            return false;
        };
        let mut mac = HmacSha256::new_from_slice(self.signing_key.as_ref())
            .expect("HMAC accepts a fixed 32-byte key");
        mac.update(b"shellspan-agent-capability-native\0");
        mac.update(nonce.as_bytes());
        mac.verify_slice(&claimed_bytes).is_ok()
    }
}

impl AgentCapabilityVerifierNative for NativeCapabilityStoreNative {
    fn verify(
        &self,
        capability_id: &str,
        context: AgentCapabilityVerificationContextNative<'_>,
        now_unix_ms: u64,
    ) -> Result<VerifiedAgentCapabilityNative, AgentCapabilityVerificationFailureNative> {
        if !self.proof_is_valid(capability_id) {
            return Err(AgentCapabilityVerificationFailureNative::InvalidProof);
        }
        let records = self
            .records
            .lock()
            .map_err(|_| AgentCapabilityVerificationFailureNative::Unknown)?;
        let record = records
            .get(capability_id)
            .ok_or(AgentCapabilityVerificationFailureNative::Unknown)?;
        if record.capability_id != capability_id
            || record.request_id != context.request_id
            || record.user_session_id != context.user_session_id
            || !record
                .allowed_call_ids
                .iter()
                .any(|id| id == context.call_id)
            || !record.target_ids.iter().any(|id| id == context.target_id)
            || record.uses >= record.max_uses
        {
            return Err(AgentCapabilityVerificationFailureNative::InvalidProof);
        }
        if record.revoked {
            return Err(AgentCapabilityVerificationFailureNative::Revoked);
        }
        if now_unix_ms < record.not_before_unix_ms || now_unix_ms >= record.expires_at_unix_ms {
            return Err(AgentCapabilityVerificationFailureNative::Expired);
        }
        Ok(VerifiedAgentCapabilityNative::from_verified_claims(
            record.capability_id.clone(),
            record.request_id.clone(),
            record.user_session_id.clone(),
            record.allowed_tools.clone(),
            record.allowed_effects.clone(),
            record.target_ids.clone(),
            record.not_before_unix_ms,
            record.expires_at_unix_ms,
            record.revoked,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(store: &NativeCapabilityStoreNative, now: u64) -> IssuedCapabilityNative {
        store
            .issue(
                CapabilityIssueRequestNative {
                    request_id: "req-1".into(),
                    user_session_id: "user-1".into(),
                    call_id: "call-1".into(),
                    call_digest: "a".repeat(64),
                    allowed_tools: vec!["exec_command".into()],
                    allowed_effects: vec![AgentEffectKindNative::ReadOnly],
                    target_ids: vec!["local-1".into()],
                    ttl_ms: 1_000,
                    max_uses: 1,
                },
                now,
            )
            .unwrap()
    }

    fn context<'a>() -> AgentCapabilityVerificationContextNative<'a> {
        AgentCapabilityVerificationContextNative {
            request_id: "req-1",
            user_session_id: "user-1",
            call_id: "call-1",
            target_id: "local-1",
        }
    }

    #[test]
    fn native_proof_is_short_lived_call_bound_revocable_and_single_use() {
        let store = NativeCapabilityStoreNative::with_signing_key([7; 32]);
        let issued = issue(&store, 10_000);
        assert!(store
            .verify(&issued.capability_id, context(), 10_500)
            .is_ok());

        let wrong_call = AgentCapabilityVerificationContextNative {
            call_id: "call-2",
            ..context()
        };
        assert_eq!(
            store.verify(&issued.capability_id, wrong_call, 10_500),
            Err(AgentCapabilityVerificationFailureNative::InvalidProof)
        );
        assert_eq!(
            store.verify(&issued.capability_id, context(), 11_000),
            Err(AgentCapabilityVerificationFailureNative::Expired)
        );

        let second = issue(&store, 20_000);
        store.revoke(&second.capability_id).unwrap();
        assert_eq!(
            store.verify(&second.capability_id, context(), 20_001),
            Err(AgentCapabilityVerificationFailureNative::Revoked)
        );

        let third = issue(&store, 30_000);
        store.consume(&third.capability_id, 30_001).unwrap();
        assert_eq!(
            store.verify(&third.capability_id, context(), 30_001),
            Err(AgentCapabilityVerificationFailureNative::InvalidProof)
        );
    }

    #[test]
    fn fabricated_or_modified_ids_never_resolve_claims() {
        let store = NativeCapabilityStoreNative::with_signing_key([11; 32]);
        let issued = issue(&store, 1);
        let mut forged = issued.capability_id.clone();
        let last = forged.pop().unwrap();
        forged.push(if last == '0' { '1' } else { '0' });
        assert_eq!(
            store.verify(&forged, context(), 2),
            Err(AgentCapabilityVerificationFailureNative::InvalidProof)
        );
    }

    #[test]
    fn restart_never_revives_an_issued_or_consumed_capability() {
        let before_restart = NativeCapabilityStoreNative::with_signing_key([19; 32]);
        let issued = issue(&before_restart, 1_000);
        before_restart
            .consume(&issued.capability_id, 1_001)
            .unwrap();

        let after_restart = NativeCapabilityStoreNative::with_signing_key([23; 32]);
        assert_eq!(
            after_restart.verify(&issued.capability_id, context(), 1_002),
            Err(AgentCapabilityVerificationFailureNative::InvalidProof)
        );
    }

    #[test]
    fn capability_is_bound_to_the_exact_native_call_digest() {
        let store = NativeCapabilityStoreNative::with_signing_key([13; 32]);
        let issued = issue(&store, 1_000);
        assert!(store
            .verify_bound_call(&issued.capability_id, context(), &"a".repeat(64), 1_001)
            .is_ok());
        assert_eq!(
            store.verify_bound_call(&issued.capability_id, context(), &"b".repeat(64), 1_001,),
            Err(AgentCapabilityVerificationFailureNative::InvalidProof)
        );
        assert_eq!(
            store.consume(&issued.capability_id, issued.expires_at_unix_ms),
            Err(CapabilityStoreErrorNative::Expired)
        );
    }
}
