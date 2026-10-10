//! Paged creation checkpoints. Native protected publication and object handling
//! must supply the callbacks; these records alone authorize no filesystem work.
use crate::frontend_bundle_plan::{BundlePlan, PlannedObject};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const PAGE_OBJECTS: usize = 64;
const PAGE_BYTES: usize = 65536;
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectIdentity {
    pub volume: u32,
    pub file_id: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, path::Path};
    fn plan() -> BundlePlan {
        let root = Path::new(r"D:\repo\node_modules");
        crate::frontend_bundle_plan::build(
            root,
            &[root.join("store")],
            &[root.join("store/file.js")],
            &[(root.join("pkg"), root.join("store"))],
        )
        .unwrap()
    }
    fn identity(index: u64) -> ObjectIdentity {
        ObjectIdentity {
            volume: 7,
            file_id: index + 100,
        }
    }
    fn journal() -> BundleJournal {
        BundleJournal::prepare(
            &plan(),
            Uuid::new_v4(),
            identity(0),
            &"a".repeat(64),
            |_, _| Ok(()),
        )
        .unwrap()
    }
    #[test]
    fn creation_stamps_derive_exact_record_binding() {
        use crate::frontend_creation_stamp::{CreationKind, CreationStamp};
        let journal = journal();
        let root = std::env::temp_dir().join(format!("shellspan-stamp-binding-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        for index in 0..journal.retirement_object_count() {
            let view = journal.retirement_view(index).unwrap();
            let kind = match view.kind {
                "directory" => CreationKind::Directory,
                "file" => CreationKind::File,
                "alias" => CreationKind::Alias,
                _ => panic!("unexpected plan kind"),
            };
            let page = &journal.pages[index / PAGE_OBJECTS];
            let expected = CreationStamp::new(
                page.fixture_id,
                index,
                kind,
                &page.inventory_sha256,
                &page.plan_sha256,
            )
            .unwrap();
            let path = root.join(index.to_string());
            let created = expected.create_new(&path).unwrap();
            let derived = journal.creation_stamp(index).unwrap();
            derived.verify(&created).unwrap();
            assert!(journal
                .creation_stamp((index + 1) % journal.retirement_object_count())
                .unwrap()
                .verify(&created)
                .is_err());
            drop(created);
            let observed = derived.observe(&path).unwrap();
            assert_ne!(observed.identity().file_id, 0);
            drop(observed);
        }
        assert!(journal
            .creation_stamp(journal.retirement_object_count())
            .is_err());
        trash::delete(root).unwrap();
    }
    #[test]
    fn recovered_identity_binding_keeps_creation_stopped_and_publication_failure_atomic() {
        let mut journal = journal();
        assert!(journal
            .checkpoint_recovered_creation(0, identity(1), |_, _| {
                panic!("live creation must not accept recovery binding")
            })
            .is_err());
        journal.stop_creation();
        assert!(journal
            .checkpoint_recovered_creation(1, identity(2), |_, _| {
                panic!("uncommitted parent must reject recovered child")
            })
            .is_err());
        let before = encode(&journal.pages[0]).unwrap();
        assert!(journal
            .checkpoint_recovered_creation(0, identity(1), |_, _| {
                Err("recovery publication failure".into())
            })
            .is_err());
        assert_eq!(encode(&journal.pages[0]).unwrap(), before);
        assert!(journal.creation_admitted(0).is_err());
        for index in 0..4 {
            journal
                .checkpoint_recovered_creation(index, identity(index as u64 + 1), |_, _| Ok(()))
                .unwrap();
            assert!(journal.creation_admitted(index).is_err());
        }
        assert!(journal
            .checkpoint_recovered_creation(0, identity(9), |_, _| {
                panic!("bound identity must not be replaced")
            })
            .is_err());
        let fixture = journal.pages[0].fixture_id;
        let pages: Vec<_> = journal
            .pages
            .iter()
            .map(|page| encode(page).unwrap())
            .collect();
        let mut loaded = BundleJournal::restore_for_retirement(
            &plan(),
            fixture,
            identity(0),
            &"a".repeat(64),
            |index| Ok(pages[index].clone()),
        )
        .unwrap();
        assert!(loaded.creation_admitted(0).is_err());
        for index in (0..4).rev() {
            loaded
                .checkpoint_retired(index, Some(&identity(index as u64 + 1)), |_, _| Ok(()))
                .unwrap();
        }
        assert!(loaded.retirement_confirmed());
    }
    #[test]
    fn batch_requires_durable_parents_and_commits_one_recoverable_page() {
        let root = Path::new(r"D:\repo\node_modules");
        let plan = crate::frontend_bundle_plan::build(
            root,
            &[],
            &[root.join("a.js"), root.join("b.js")],
            &[],
        )
        .unwrap();
        let fixture = Uuid::new_v4();
        let mut journal =
            BundleJournal::prepare(&plan, fixture, identity(0), &"a".repeat(64), |_, _| Ok(()))
                .unwrap();
        assert!(journal
            .checkpoint_created_batch(&[(0, identity(1)), (1, identity(2))], |_, _| panic!(
                "parent in same batch is not durable"
            ))
            .is_err());
        journal
            .checkpoint_created(0, identity(1), |_, _| Ok(()))
            .unwrap();
        for batch in [
            vec![],
            vec![(1, identity(2)), (1, identity(3))],
            vec![(1, identity(2)), (2, identity(2))],
            vec![(1, identity(2)), (64, identity(3))],
        ] {
            assert!(journal
                .checkpoint_created_batch(&batch, |_, _| panic!("invalid batch must not publish"))
                .is_err());
        }
        let mut publications = 0;
        journal
            .checkpoint_created_batch(&[(1, identity(2)), (2, identity(3))], |_, bytes| {
                publications += 1;
                let page: Page = serde_json::from_slice(bytes).unwrap();
                assert_eq!(page.revision, 3);
                assert!(page.records.iter().all(|r| r.state == State::Applied));
                Ok(())
            })
            .unwrap();
        assert_eq!(publications, 1);
        let pages: Vec<_> = journal.pages.iter().map(|p| encode(p).unwrap()).collect();
        let recovered = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |index| Ok(pages[index].clone()),
        )
        .unwrap();
        assert!(recovered.creation_admitted(1).is_err());
        assert!(!recovered.retirement_confirmed());
    }
    #[test]
    fn failed_batch_publication_keeps_all_objects_planned_and_stops_creation() {
        let mut journal = journal();
        journal
            .checkpoint_created(0, identity(1), |_, _| Ok(()))
            .unwrap();
        journal
            .checkpoint_created(1, identity(2), |_, _| Ok(()))
            .unwrap();
        let before = encode(&journal.pages[0]).unwrap();
        assert!(journal
            .checkpoint_created_batch(&[(2, identity(3)), (3, identity(4))], |_, _| Err(
                "protected page publication failed".into()
            ))
            .is_err());
        assert_eq!(encode(&journal.pages[0]).unwrap(), before);
        assert!(journal.creation_admitted(2).is_err());
        assert!(!journal.retirement_confirmed());
    }
    #[test]
    fn creation_and_reverse_retirement_require_all_dependencies_and_exact_ids() {
        let mut journal = journal();
        assert!(!journal.retirement_confirmed());
        assert!(journal.creation_admitted(1).is_err());
        assert!(journal
            .checkpoint_created(0, identity(0), |_, _| panic!(
                "must not publish parent identity"
            ))
            .is_err());
        assert!(journal
            .checkpoint_created(
                0,
                ObjectIdentity {
                    volume: 8,
                    file_id: 1
                },
                |_, _| panic!("must not publish cross-volume identity")
            )
            .is_err());
        for index in 0..4 {
            if index == 1 {
                assert!(journal
                    .checkpoint_created(index, identity(1), |_, _| panic!(
                        "must not publish duplicate native identity"
                    ))
                    .is_err());
            }
            journal.creation_admitted(index).unwrap();
            journal
                .checkpoint_created(index, identity(index as u64 + 1), |_, _| Ok(()))
                .unwrap();
        }
        assert!(journal
            .checkpoint_retired(1, Some(&identity(2)), |_, _| panic!(
                "must not retire live target"
            ))
            .is_err());
        assert!(journal
            .checkpoint_retired(3, Some(&identity(99)), |_, _| panic!(
                "must not retire replacement identity"
            ))
            .is_err());
        for index in (0..4).rev() {
            journal
                .checkpoint_retired(index, Some(&identity(index as u64 + 1)), |_, _| Ok(()))
                .unwrap();
        }
        assert!(journal.retirement_confirmed());
        journal
            .checkpoint_retired(0, Some(&identity(1)), |_, _| {
                panic!("duplicate retirement must not republish")
            })
            .unwrap();
        assert!(journal.creation_admitted(0).is_err());
    }
    #[test]
    fn cancellation_blocks_creation_without_inferring_cleanup() {
        let mut journal = journal();
        journal.creation_admitted(0).unwrap();
        journal.stop_creation();
        assert!(journal.creation_admitted(0).is_err());
        assert!(!journal.retirement_confirmed());
        assert!(journal
            .checkpoint_created(0, identity(1), |_, _| panic!(
                "cancelled creation must not publish"
            ))
            .is_err());
        for index in (0..4).rev() {
            journal
                .checkpoint_retired(index, None, |_, _| Ok(()))
                .unwrap();
        }
        assert!(journal.retirement_confirmed());
    }
    #[test]
    fn independent_recovery_loads_partial_state_and_never_resumes_creation() {
        let plan = plan();
        let encoded_plan = serde_json::to_vec(&plan).unwrap();
        let fixture = Uuid::new_v4();
        let mut journal =
            BundleJournal::prepare(&plan, fixture, identity(0), &"a".repeat(64), |_, _| Ok(()))
                .unwrap();
        for index in 0..3 {
            journal
                .checkpoint_created(index, identity(index as u64 + 1), |_, _| Ok(()))
                .unwrap();
        }
        let pages: Vec<_> = journal.pages.iter().map(|p| encode(p).unwrap()).collect();
        drop(journal);
        drop(plan);
        let plan = BundlePlan::read_bound(&encoded_plan, &hash(&encoded_plan)).unwrap();
        let mut recovered = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |index| Ok(pages[index].clone()),
        )
        .unwrap();
        assert!(recovered.creation_admitted(3).is_err());
        assert!(!recovered.retirement_confirmed());
        recovered
            .checkpoint_retired(3, None, |_, _| Ok(()))
            .unwrap();
        for index in (0..3).rev() {
            recovered
                .checkpoint_retired(index, Some(&identity(index as u64 + 1)), |_, _| Ok(()))
                .unwrap();
        }
        assert!(recovered.retirement_confirmed());
    }
    #[test]
    fn recovery_refuses_changed_bindings_objects_revisions_and_unknown_fields() {
        let plan = plan();
        let fixture = Uuid::new_v4();
        let journal =
            BundleJournal::prepare(&plan, fixture, identity(0), &"a".repeat(64), |_, _| Ok(()))
                .unwrap();
        let original = serde_json::to_value(&journal.pages[0]).unwrap();
        for (key, value) in [
            ("version", serde_json::json!(2)),
            ("fixture_id", serde_json::json!(Uuid::new_v4())),
            ("inventory_sha256", serde_json::json!("b".repeat(64))),
            ("plan_sha256", serde_json::json!("b".repeat(64))),
            ("page", serde_json::json!(1)),
            ("pages", serde_json::json!(2)),
            ("revision", serde_json::json!(1)),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            let bytes = serde_json::to_vec(&changed).unwrap();
            assert!(
                BundleJournal::restore_for_retirement(
                    &plan,
                    fixture,
                    identity(0),
                    &"a".repeat(64),
                    |_| Ok(bytes.clone())
                )
                .is_err(),
                "accepted changed {key}"
            );
        }
        let mut changed = original.clone();
        changed["records"][2]["object"]["path"] = serde_json::json!("../outside");
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(bytes.clone())
        )
        .is_err());
        changed = original.clone();
        changed["records"][0]["state"] = serde_json::json!("applied");
        changed["revision"] = serde_json::json!(1);
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(bytes.clone())
        )
        .is_err());
        changed = original;
        changed["records"].as_array_mut().unwrap().pop();
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(bytes.clone())
        )
        .is_err());
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(vec![b' '; PAGE_BYTES + 1])
        )
        .is_err());
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Err("missing protected page".into())
        )
        .is_err());
    }
    #[test]
    fn recovery_refuses_overlapping_native_ids_and_impossible_dependencies() {
        let plan = plan();
        let fixture = Uuid::new_v4();
        let mut journal =
            BundleJournal::prepare(&plan, fixture, identity(0), &"a".repeat(64), |_, _| Ok(()))
                .unwrap();
        for index in 0..3 {
            journal
                .checkpoint_created(index, identity(index as u64 + 1), |_, _| Ok(()))
                .unwrap();
        }
        let original = serde_json::to_value(&journal.pages[0]).unwrap();
        let mut changed = original.clone();
        changed["records"][2]["identity"] = changed["records"][1]["identity"].clone();
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(bytes.clone())
        )
        .is_err());
        changed = original.clone();
        changed["records"][1]["state"] = serde_json::json!("retired");
        changed["revision"] = serde_json::json!(4);
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(bytes.clone())
        )
        .is_err());
        changed = original;
        changed["records"][0]["identity"]["volume"] = serde_json::json!(8);
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            identity(0),
            &"a".repeat(64),
            |_| Ok(bytes.clone())
        )
        .is_err());
    }
    #[test]
    fn post_creation_publish_failure_preserves_planned_state_and_blocks_dispatch() {
        let mut journal = journal();
        let before = encode(&journal.pages[0]).unwrap();
        assert!(journal
            .checkpoint_created(0, identity(1), |_, _| Err(
                "injected publication failure".into()
            ))
            .is_err());
        assert_eq!(encode(&journal.pages[0]).unwrap(), before);
        assert!(journal.creation_admitted(0).is_err());
        assert!(!journal.retirement_confirmed());
        // These checkpoints represent independently verified absence; the
        // journal does not infer absence from Planned or from save failure.
        for index in (0..4).rev() {
            journal
                .checkpoint_retired(index, None, |_, _| Ok(()))
                .unwrap();
        }
        assert!(journal.retirement_confirmed());
    }
    #[test]
    fn retirement_publish_failure_retains_dependencies_until_retry_commits() {
        let mut journal = journal();
        let before = encode(&journal.pages[0]).unwrap();
        assert!(journal
            .checkpoint_retired(3, None, |_, _| Err(
                "injected retirement save failure".into()
            ))
            .is_err());
        assert_eq!(encode(&journal.pages[0]).unwrap(), before);
        assert!(journal.creation_admitted(0).is_err());
        journal.checkpoint_retired(3, None, |_, _| Ok(())).unwrap();
        journal.checkpoint_retired(2, None, |_, _| Ok(())).unwrap();
        journal.checkpoint_retired(1, None, |_, _| Ok(())).unwrap();
        journal.checkpoint_retired(0, None, |_, _| Ok(())).unwrap();
        assert!(journal.retirement_confirmed());
    }
    #[test]
    fn partial_initial_publication_never_returns_creation_authority() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-bundle-journal-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = Path::new(r"D:\repo\node_modules");
        let files: Vec<_> = (0..130)
            .map(|i| source.join(format!("file-{i}.js")))
            .collect();
        let plan = crate::frontend_bundle_plan::build(source, &[], &files, &[]).unwrap();
        let mut calls = 0;
        let result = BundleJournal::prepare(
            &plan,
            Uuid::new_v4(),
            identity(0),
            &"a".repeat(64),
            |index, bytes| {
                calls += 1;
                if index == 1 {
                    return Err("fixed prepare publication failure".into());
                }
                let mut file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(root.join(format!("page-{index}.json")))
                    .map_err(|e| e.to_string())?;
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())
            },
        );
        assert!(result.is_err());
        assert_eq!(calls, 2);
        assert!(root.join("page-0.json").exists());
        assert!(!root.join("page-1.json").exists());
        assert!(!root.join("page-2.json").exists());
        let retained: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("page-0.json")).unwrap()).unwrap();
        assert!(retained["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["state"] == "planned" && r["identity"].is_null()));
        trash::delete(root).unwrap();
    }
    #[test]
    fn binding_and_page_budget_fail_before_any_publication() {
        assert!(BundleJournal::prepare(
            &plan(),
            Uuid::nil(),
            identity(0),
            &"a".repeat(64),
            |_, _| panic!("invalid fixture must not publish")
        )
        .is_err());
        assert!(BundleJournal::prepare(
            &plan(),
            Uuid::new_v4(),
            identity(0),
            &"A".repeat(64),
            |_, _| panic!("invalid digest must not publish")
        )
        .is_err());
        let root = Path::new(r"D:\repo\node_modules");
        let files: Vec<_> = (0..64)
            .map(|i| root.join(format!("{i}-{}", "x".repeat(2000))))
            .collect();
        let plan = crate::frontend_bundle_plan::build(root, &[], &files, &[]).unwrap();
        assert!(BundleJournal::prepare(
            &plan,
            Uuid::new_v4(),
            identity(0),
            &"a".repeat(64),
            |_, _| panic!("oversized page must not publish")
        )
        .is_err());
    }
    #[test]
    fn complete_measured_plan_fits_bounded_pages_and_linear_dependency_index() {
        let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../docs/design/evidence/windows-stage-a-2026-10-10-frontend-bundle-plan.json",
        );
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(evidence).unwrap()).unwrap();
        let measured = &record["plan"];
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("node_modules");
        let paths = |field: &str| {
            measured[field]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| root.join(p.as_str().unwrap()))
                .collect::<Vec<_>>()
        };
        let aliases: Vec<_> = measured["aliases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                (
                    root.join(a["path"].as_str().unwrap()),
                    root.join(a["target"].as_str().unwrap()),
                )
            })
            .collect();
        let plan = crate::frontend_bundle_plan::build(
            &root,
            &paths("directories"),
            &paths("files"),
            &aliases,
        )
        .unwrap();
        let mut pages = 0;
        let mut records = 0;
        let mut max_bytes = 0;
        let mut journal = BundleJournal::prepare(
            &plan,
            Uuid::new_v4(),
            identity(0),
            &"a".repeat(64),
            |index, bytes| {
                assert_eq!(index, pages);
                let page: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                assert!(page["records"].as_array().unwrap().len() <= PAGE_OBJECTS);
                records += page["records"].as_array().unwrap().len();
                max_bytes = max_bytes.max(bytes.len());
                pages += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(pages, 677);
        assert_eq!(records, 43290);
        assert!(max_bytes < PAGE_BYTES);
        assert_eq!(journal.requirements.len(), 43290);
        assert!(journal.requirements.iter().all(|r| r.len() <= 2));
        assert!(!journal.retirement_confirmed());
        let mut transitions = 0;
        for index in 0..records {
            journal.creation_admitted(index).unwrap();
            journal
                .checkpoint_created(index, identity(index as u64 + 1), |_, bytes| {
                    assert!(bytes.len() <= PAGE_BYTES);
                    transitions += 1;
                    Ok(())
                })
                .unwrap();
        }
        assert!(!journal.retirement_confirmed());
        for index in (0..records).rev() {
            journal
                .checkpoint_retired(index, Some(&identity(index as u64 + 1)), |_, bytes| {
                    assert!(bytes.len() <= PAGE_BYTES);
                    transitions += 1;
                    Ok(())
                })
                .unwrap();
        }
        assert_eq!(transitions, 86580);
        assert!(journal.retirement_confirmed());
        let encoded_plan = serde_json::to_vec(&plan).unwrap();
        let recovered_plan = BundlePlan::read_bound(&encoded_plan, &hash(&encoded_plan)).unwrap();
        let recovered = BundleJournal::restore_for_retirement(
            &recovered_plan,
            journal.pages[0].fixture_id,
            identity(0),
            &"a".repeat(64),
            |index| encode(&journal.pages[index]),
        )
        .unwrap();
        assert!(recovered.retirement_confirmed());
        assert!(recovered.creation_admitted(0).is_err());
    }
}
impl ObjectIdentity {
    fn validate(&self) -> Result<(), String> {
        if self.volume == 0 || self.file_id == 0 {
            return Err("bundle identity incomplete".into());
        }
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum State {
    Planned,
    Applied,
    Retired,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    object: PlannedObject,
    state: State,
    identity: Option<ObjectIdentity>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Page {
    version: u32,
    fixture_id: Uuid,
    /// The existing protected fixture is the owning parent of the new bundle.
    parent: ObjectIdentity,
    inventory_sha256: String,
    plan_sha256: String,
    page: usize,
    pages: usize,
    revision: u64,
    records: Vec<Record>,
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn encode(page: &Page) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(page).map_err(|e| e.to_string())?;
    if bytes.len() > PAGE_BYTES {
        return Err("bundle checkpoint page byte budget exceeded".into());
    }
    Ok(bytes)
}
pub struct BundleJournal {
    pages: Vec<Page>,
    identities: BTreeSet<(u32, u64)>,
    faulted: bool,
    requirements: Vec<Vec<usize>>,
    remaining: Vec<usize>,
}
pub struct RetirementView<'a> {
    pub path: &'a str,
    pub kind: &'a str,
    pub target: Option<&'a str>,
    pub identity: Option<&'a ObjectIdentity>,
    pub retired: bool,
}
impl BundleJournal {
    /// Derive the expected marker exclusively from the bound durable record.
    /// Native callers must prove namespace ownership before observing objects.
    pub fn creation_stamp(
        &self,
        index: usize,
    ) -> Result<crate::frontend_creation_stamp::CreationStamp, String> {
        use crate::frontend_creation_stamp::{CreationKind, CreationStamp};
        let page = self
            .pages
            .get(index / PAGE_OBJECTS)
            .ok_or("bundle creation stamp index invalid")?;
        let record = page
            .records
            .get(index % PAGE_OBJECTS)
            .ok_or("bundle creation stamp index invalid")?;
        let kind = match record.object.kind.as_str() {
            "directory" => CreationKind::Directory,
            "file" => CreationKind::File,
            "alias" => CreationKind::Alias,
            _ => return Err("bundle creation stamp kind invalid".into()),
        };
        CreationStamp::new(
            page.fixture_id,
            index,
            kind,
            &page.inventory_sha256,
            &page.plan_sha256,
        )
    }
    pub fn retirement_object_count(&self) -> usize {
        self.pages.iter().map(|page| page.records.len()).sum()
    }
    pub fn owning_parent(&self) -> &ObjectIdentity {
        &self.pages[0].parent
    }
    /// Observations from the bound record; callers still verify current OS
    /// identity/absence before publishing retirement.
    pub fn retirement_view(&self, index: usize) -> Result<RetirementView<'_>, String> {
        let record = self
            .pages
            .get(index / PAGE_OBJECTS)
            .and_then(|page| page.records.get(index % PAGE_OBJECTS))
            .ok_or("bundle retirement view index invalid")?;
        Ok(RetirementView {
            path: &record.object.path,
            kind: &record.object.kind,
            target: record.object.target.as_deref(),
            identity: record.identity.as_ref(),
            retired: record.state == State::Retired,
        })
    }
    /// Read only through a native reader that verifies protected ownership and
    /// stable objects. Every page must match the trusted complete plan/anchor.
    /// The returned journal can retire resources, never resume creation.
    pub fn restore_for_retirement(
        plan: &BundlePlan,
        fixture_id: Uuid,
        parent: ObjectIdentity,
        inventory_sha256: &str,
        mut read_page: impl FnMut(usize) -> Result<Vec<u8>, String>,
    ) -> Result<Self, String> {
        let mut journal = Self::prepare(plan, fixture_id, parent, inventory_sha256, |_, _| Ok(()))?;
        journal.faulted = true;
        let mut loaded = Vec::with_capacity(journal.pages.len());
        let mut identities = BTreeSet::new();
        for expected in &journal.pages {
            let bytes = read_page(expected.page)?;
            if bytes.len() > PAGE_BYTES {
                return Err("bundle recovery page byte budget exceeded".into());
            }
            let page: Page =
                serde_json::from_slice(&bytes).map_err(|_| "bundle recovery page JSON invalid")?;
            if page.version != expected.version
                || page.fixture_id != expected.fixture_id
                || page.parent != expected.parent
                || page.inventory_sha256 != expected.inventory_sha256
                || page.plan_sha256 != expected.plan_sha256
                || page.page != expected.page
                || page.pages != expected.pages
                || page.records.len() != expected.records.len()
            {
                return Err("bundle recovery page binding differs".into());
            }
            let mut revision = 0u64;
            for (record, expected) in page.records.iter().zip(&expected.records) {
                if record.object != expected.object {
                    return Err("bundle recovery object plan differs".into());
                }
                match record.state {
                    State::Planned if record.identity.is_some() => {
                        return Err("planned bundle object carries an identity".into())
                    }
                    State::Applied if record.identity.is_none() => {
                        return Err("applied bundle object lacks identity".into())
                    }
                    State::Applied => revision += 1,
                    State::Retired => revision += 1 + u64::from(record.identity.is_some()),
                    State::Planned => {}
                }
                if let Some(identity) = &record.identity {
                    identity.validate()?;
                    if identity.volume != page.parent.volume
                        || identity == &page.parent
                        || !identities.insert((identity.volume, identity.file_id))
                    {
                        return Err(
                            "bundle recovery object identity overlaps or escaped parent".into()
                        );
                    }
                }
            }
            if page.revision != revision {
                return Err(
                    "bundle recovery page revision differs from committed transitions".into(),
                );
            }
            loaded.push(page);
        }
        journal.pages = loaded;
        journal.identities = identities;
        journal.remaining.fill(0);
        for (index, requirements) in journal.requirements.iter().enumerate() {
            let record = &journal.pages[index / PAGE_OBJECTS].records[index % PAGE_OBJECTS];
            for required in requirements {
                let dependency =
                    &journal.pages[*required / PAGE_OBJECTS].records[*required % PAGE_OBJECTS];
                if (record.state == State::Applied && dependency.state != State::Applied)
                    || (record.state != State::Retired && dependency.state == State::Retired)
                    || (record.identity.is_some() && dependency.identity.is_none())
                {
                    return Err("bundle recovery dependency state inconsistent".into());
                }
                if record.state != State::Retired {
                    journal.remaining[*required] += 1;
                }
            }
        }
        Ok(journal)
    }
    /// The callback must create each new protected page without adopting an
    /// existing page. No journal is returned unless every planned page commits.
    pub fn prepare(
        plan: &BundlePlan,
        fixture_id: Uuid,
        parent: ObjectIdentity,
        inventory_sha256: &str,
        mut publish_new: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<Self, String> {
        parent.validate()?;
        if fixture_id.is_nil()
            || inventory_sha256.len() != 64
            || !inventory_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("bundle journal binding invalid".into());
        }
        let objects = plan.objects();
        if objects.len() > 100000 {
            return Err("bundle journal object budget exceeded".into());
        }
        let count = objects.len().div_ceil(PAGE_OBJECTS);
        let positions: BTreeMap<_, _> = objects
            .iter()
            .enumerate()
            .map(|(index, object)| (object.path.as_str(), index))
            .collect();
        if positions.len() != objects.len() {
            return Err("bundle journal plan has duplicate paths".into());
        }
        let mut requirements = vec![Vec::new(); objects.len()];
        let mut remaining = vec![0; objects.len()];
        for (index, object) in objects.iter().enumerate() {
            if !object.path.is_empty() {
                let parent = object
                    .path
                    .rsplit_once('/')
                    .map_or("", |(parent, _)| parent);
                requirements[index].push(
                    *positions
                        .get(parent)
                        .ok_or("bundle journal parent missing")?,
                );
            }
            if let Some(target) = &object.target {
                requirements[index].push(
                    *positions
                        .get(target.as_str())
                        .ok_or("bundle journal alias target missing")?,
                );
            }
            requirements[index].sort_unstable();
            requirements[index].dedup();
            for required in &requirements[index] {
                if *required >= index || objects[*required].kind != "directory" {
                    return Err("bundle journal dependency order invalid".into());
                }
                remaining[*required] += 1;
            }
        }
        let plan_sha256 = hash(&serde_json::to_vec(plan).map_err(|e| e.to_string())?);
        let mut pages = Vec::new();
        for (index, chunk) in objects.chunks(PAGE_OBJECTS).enumerate() {
            pages.push(Page {
                version: 1,
                fixture_id,
                parent: parent.clone(),
                inventory_sha256: inventory_sha256.into(),
                plan_sha256: plan_sha256.clone(),
                page: index,
                pages: count,
                revision: 0,
                records: chunk
                    .iter()
                    .map(|object| Record {
                        object: object.clone(),
                        state: State::Planned,
                        identity: None,
                    })
                    .collect(),
            });
        }
        // Validate every page budget before any protected publication.
        for page in &pages {
            let mut largest = page.clone();
            largest.revision = u64::MAX;
            for record in &mut largest.records {
                record.state = State::Applied;
                record.identity = Some(ObjectIdentity {
                    volume: u32::MAX,
                    file_id: u64::MAX,
                });
            }
            encode(&largest)?;
        }
        for page in &pages {
            publish_new(page.page, &encode(page)?)?;
        }
        Ok(Self {
            pages,
            identities: BTreeSet::new(),
            faulted: false,
            requirements,
            remaining,
        })
    }
    /// Ordering gate only; native code must still verify protected parent,
    /// namespace and held OS identities before touching a destination.
    pub fn creation_admitted(&self, index: usize) -> Result<(), String> {
        if self.faulted {
            return Err("bundle journal fault requires recovery".into());
        }
        self.planned_dependencies(index)
    }
    fn planned_dependencies(&self, index: usize) -> Result<(), String> {
        let record = self
            .pages
            .get(index / PAGE_OBJECTS)
            .and_then(|page| page.records.get(index % PAGE_OBJECTS))
            .ok_or("bundle checkpoint index invalid")?;
        if record.state != State::Planned {
            return Err("bundle creation checkpoint state invalid".into());
        }
        if self.requirements[index].iter().any(|required| {
            self.pages[*required / PAGE_OBJECTS].records[*required % PAGE_OBJECTS].state
                != State::Applied
        }) {
            return Err("bundle creation dependency not committed".into());
        }
        Ok(())
    }
    pub fn stop_creation(&mut self) {
        self.faulted = true;
    }
    /// A failed post-creation publication preserves planned durable state and
    /// blocks all later creation. The native owner must retain recovery debt.
    pub fn checkpoint_created(
        &mut self,
        index: usize,
        identity: ObjectIdentity,
        replace_page: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        self.checkpoint_created_batch(&[(index, identity)], replace_page)
    }
    /// One atomic page publication. Every dependency must already be durable
    /// before this batch; objects in this batch cannot authorize each other.
    pub fn checkpoint_created_batch(
        &mut self,
        objects: &[(usize, ObjectIdentity)],
        replace_page: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        self.bind_created_batch(objects, replace_page, false)
    }
    /// Native recovery must first verify the atomic creation stamp and protected
    /// never-granted namespace. This records custody only, never permits creation.
    pub fn checkpoint_recovered_creation(
        &mut self,
        index: usize,
        identity: ObjectIdentity,
        replace_page: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.faulted {
            return Err("recovered identity requires creation already stopped".into());
        }
        self.bind_created_batch(&[(index, identity)], replace_page, true)
    }
    fn bind_created_batch(
        &mut self,
        objects: &[(usize, ObjectIdentity)],
        mut replace_page: impl FnMut(usize, &[u8]) -> Result<(), String>,
        recovery: bool,
    ) -> Result<(), String> {
        if objects.is_empty() || objects.len() > PAGE_OBJECTS {
            return Err("bundle creation batch size invalid".into());
        }
        let page_index = objects[0].0 / PAGE_OBJECTS;
        let mut next = self
            .pages
            .get(page_index)
            .ok_or("bundle checkpoint index invalid")?
            .clone();
        let mut indices = BTreeSet::new();
        let mut identities = BTreeSet::new();
        for (index, identity) in objects {
            if index / PAGE_OBJECTS != page_index || !indices.insert(*index) {
                return Err("bundle creation batch crosses page or repeats object".into());
            }
            if recovery {
                self.planned_dependencies(*index)?;
            } else {
                self.creation_admitted(*index)?;
            }
            identity.validate()?;
            let key = (identity.volume, identity.file_id);
            if self.identities.contains(&key) || !identities.insert(key) {
                return Err("bundle created object identity overlaps".into());
            }
            if identity.volume != next.parent.volume || *identity == next.parent {
                return Err("bundle created identity escaped owning parent".into());
            }
            let record = next
                .records
                .get_mut(index % PAGE_OBJECTS)
                .ok_or("bundle checkpoint index invalid")?;
            record.state = State::Applied;
            record.identity = Some(identity.clone());
        }
        next.revision = next
            .revision
            .checked_add(objects.len() as u64)
            .ok_or("bundle revision overflow")?;
        let bytes = encode(&next)?;
        if let Err(error) = replace_page(page_index, &bytes) {
            self.faulted = true;
            return Err(error);
        }
        self.pages[page_index] = next;
        self.identities.extend(identities);
        Ok(())
    }
    /// Native recovery first verifies absence or exact owned-object retirement.
    /// Planned objects still require recovery; this never infers their absence.
    pub fn checkpoint_retired(
        &mut self,
        index: usize,
        expected: Option<&ObjectIdentity>,
        mut replace_page: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let page_index = index / PAGE_OBJECTS;
        let record_index = index % PAGE_OBJECTS;
        let mut next = self
            .pages
            .get(page_index)
            .ok_or("bundle retirement index invalid")?
            .clone();
        let record = next
            .records
            .get_mut(record_index)
            .ok_or("bundle retirement index invalid")?;
        if record.identity.as_ref() != expected {
            return Err("bundle retirement identity differs".into());
        }
        if record.state == State::Retired {
            return Ok(());
        }
        // A directory cannot retire before any descendants, nor a target
        // directory while a live alias still points to it.
        if self.remaining[index] != 0 {
            return Err("bundle directory still has retirement dependencies".into());
        }
        record.state = State::Retired;
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or("bundle revision overflow")?;
        if let Err(error) = replace_page(page_index, &encode(&next)?) {
            self.faulted = true;
            return Err(error);
        }
        self.pages[page_index] = next;
        for required in &self.requirements[index] {
            self.remaining[*required] -= 1;
        }
        Ok(())
    }
    pub fn retirement_confirmed(&self) -> bool {
        self.pages
            .iter()
            .flat_map(|p| p.records.iter())
            .all(|r| r.state == State::Retired)
    }
}
