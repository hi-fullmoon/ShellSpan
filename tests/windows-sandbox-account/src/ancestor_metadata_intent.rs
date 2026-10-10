//! Fixed ProgramData ancestor ACL experiment ownership contract.
//! Validation is not permission to mutate: persist in a protected receipt and
//! revalidate held OS objects before granting or recovering any ACE.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::{FILE_READ_ATTRIBUTES, SYNCHRONIZE};

pub const METADATA_MASK: u32 = FILE_READ_ATTRIBUTES | SYNCHRONIZE;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AncestorObject {
    pub path: PathBuf,
    pub volume: u32,
    pub file_id: u64,
    /// Digest of the pre-mutation DACL; never restore the entire old DACL.
    pub original_dacl_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationState {
    Planned,
    Applied,
    Retired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AncestorMetadataIntent {
    pub version: u32,
    pub fixture_id: Uuid,
    pub package_sid: String,
    pub access_mask: u32,
    pub inheritance_flags: u32,
    /// Exact order: drive root, ProgramData. The owned fixture already has access.
    pub objects: [AncestorObject; 2],
    /// Per-object checkpoints preserve partial application and partial retirement.
    pub states: [MutationState; 2],
}

impl AncestorMetadataIntent {
    pub fn validate(&self, fixture: Uuid, root: &Path) -> Result<(), String> {
        let expected_root =
            PathBuf::from(format!(r"C:\ProgramData\ShellSpan-AC-{}", fixture.simple()));
        let expected_paths = [Path::new(r"C:\"), Path::new(r"C:\ProgramData")];
        if fixture.is_nil()
            || self.version != 1
            || self.fixture_id != fixture
            || root.as_os_str() != expected_root.as_os_str()
            || self.package_sid != crate::package_network_intent::expected_package_sid(fixture)?
            || self.access_mask != METADATA_MASK
            || self.inheritance_flags != 0
        {
            return Err("ancestor metadata intent binding or ACE scope differs".into());
        }
        for (object, expected) in self.objects.iter().zip(expected_paths) {
            if object.path.as_os_str() != expected.as_os_str()
                || object.volume == 0
                || object.file_id == 0
                || object.original_dacl_sha256.len() != 64
                || !object
                    .original_dacl_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("ancestor metadata intent object identity incomplete".into());
            }
        }
        if self.objects[0].volume != self.objects[1].volume
            || self.objects[0].file_id == self.objects[1].file_id
        {
            return Err("ancestor metadata objects overlap or cross volumes".into());
        }
        Ok(())
    }

    /// Recovery completion requires every precise object to have been checked.
    /// Planned also needs recovery: a crash can occur after the OS mutation and
    /// before the applied checkpoint is durably written.
    pub fn retirement_confirmed(&self) -> bool {
        self.states
            .iter()
            .all(|state| *state == MutationState::Retired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (AncestorMetadataIntent, PathBuf) {
        let fixture = Uuid::new_v4();
        let root = PathBuf::from(format!(r"C:\ProgramData\ShellSpan-AC-{}", fixture.simple()));
        let intent = AncestorMetadataIntent {
            version: 1,
            fixture_id: fixture,
            package_sid: crate::package_network_intent::expected_package_sid(fixture).unwrap(),
            access_mask: METADATA_MASK,
            inheritance_flags: 0,
            objects: [r"C:\", r"C:\ProgramData"].map(|path| AncestorObject {
                path: path.into(),
                volume: 7,
                file_id: if path == r"C:\" { 1 } else { 2 },
                original_dacl_sha256: "a".repeat(64),
            }),
            states: [MutationState::Planned, MutationState::Planned],
        };
        (intent, root)
    }
    #[test]
    fn exact_fixed_ancestors_reject_broader_permissions_and_substitution() {
        let (intent, root) = fixture();
        intent.validate(intent.fixture_id, &root).unwrap();
        for mask in [0, FILE_READ_ATTRIBUTES, METADATA_MASK | 1, u32::MAX] {
            let mut changed = intent.clone();
            changed.access_mask = mask;
            assert!(changed.validate(intent.fixture_id, &root).is_err());
        }
        for index in 0..2 {
            let mut changed = intent.clone();
            changed.objects[index].path = root.clone();
            assert!(changed.validate(intent.fixture_id, &root).is_err());
            changed = intent.clone();
            changed.objects[index].original_dacl_sha256 = "A".repeat(64);
            assert!(changed.validate(intent.fixture_id, &root).is_err());
            changed = intent.clone();
            changed.objects[index].file_id = 0;
            assert!(changed.validate(intent.fixture_id, &root).is_err());
        }
        let mut changed = intent.clone();
        changed.inheritance_flags = 3;
        assert!(changed.validate(intent.fixture_id, &root).is_err());
        changed = intent.clone();
        changed.package_sid =
            crate::package_network_intent::expected_package_sid(Uuid::new_v4()).unwrap();
        assert!(changed.validate(intent.fixture_id, &root).is_err());
        changed = intent.clone();
        changed.objects.swap(0, 1);
        assert!(changed.validate(intent.fixture_id, &root).is_err());
        assert!(intent
            .validate(
                intent.fixture_id,
                Path::new(r"C:\ProgramData\..\ProgramData")
            )
            .is_err());
        let mut value = serde_json::to_value(&intent).unwrap();
        value["objects"][0]["restore_full_dacl"] = serde_json::json!(true);
        assert!(serde_json::from_value::<AncestorMetadataIntent>(value).is_err());
    }
    #[test]
    fn partial_or_uncheckpointed_mutation_cannot_release_recovery_gate() {
        let (mut intent, _) = fixture();
        assert!(!intent.retirement_confirmed());
        for state in [MutationState::Planned, MutationState::Applied] {
            intent.states = [MutationState::Retired, state.clone()];
            assert!(!intent.retirement_confirmed());
            intent.states = [state, MutationState::Retired];
            assert!(!intent.retirement_confirmed());
        }
        intent.states = [MutationState::Retired, MutationState::Retired];
        assert!(intent.retirement_confirmed());
    }
}
