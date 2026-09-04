//! Application-owned instructions, compiled into the binary and independent of a filesystem root.
use super::{skills::*, AgentSessionTarget};
use serde::Deserialize;
use std::sync::LazyLock;

pub(crate) const PROVIDER: &str = "shellspan.builtin-skills.v1";

#[derive(Deserialize)]
struct CatalogEntry {
    name: String,
    description: String,
}

pub(crate) fn definitions() -> Vec<SkillDefinition> {
    static DEFINITIONS: LazyLock<Vec<SkillDefinition>> = LazyLock::new(|| {
        let catalog: Vec<CatalogEntry> =
            serde_json::from_str(include_str!("../../skills/catalog.json"))
                .expect("valid bundled skill catalog");
        catalog
            .into_iter()
            .map(|item| {
                let instructions = match item.name.as_str() {
                    "system-status" => include_str!("../../skills/system-status.md"),
                    "service-diagnosis" => include_str!("../../skills/service-diagnosis.md"),
                    "network-diagnosis" => include_str!("../../skills/network-diagnosis.md"),
                    "disk-cleanup" => include_str!("../../skills/disk-cleanup.md"),
                    "docker-diagnosis" => include_str!("../../skills/docker-diagnosis.md"),
                    _ => panic!("bundled skill has no instructions"),
                };
                SkillDefinition {
                    entry: SkillEntry {
                        relative_path: format!("builtin/{}.md", item.name),
                        resource_base: "builtin".into(),
                        name: item.name,
                        description: item.description,
                        model_invocable: true,
                        user_invocable: true,
                        file_hash: digest(instructions.as_bytes()),
                        instruction_hash: digest(instructions.as_bytes()),
                        extensions: Default::default(),
                    },
                    instructions: instructions.into(),
                }
            })
            .collect()
    });
    DEFINITIONS.clone()
}

pub(crate) fn scope(target: AgentSessionTarget) -> SkillScope {
    SkillScope {
        target,
        root: "builtin".into(),
        root_identity: PROVIDER.into(),
    }
}

pub(crate) fn is_builtin_scope(scope: &SkillScope) -> bool {
    scope.root_identity == PROVIDER
}
