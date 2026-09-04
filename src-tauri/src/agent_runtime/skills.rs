//! Versioned, invocation-neutral Skills protocol. Text is data, never authority.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2_compat::{Digest, Sha256};

use super::{AgentInboxMessage, AgentMessageSourceKind, AgentSessionTarget};

pub(crate) const SKILL_PROTOCOL: u32 = 1;
pub(crate) const SKILL_TOOL: &str = "skill";
pub(crate) const MAX_SKILL_FILE: usize = 128 * 1024;
pub(crate) const MAX_SKILL_RENDERED: usize = 96 * 1024;
pub(crate) const MAX_SKILL_STEP: usize = 112 * 1024;
pub(crate) const MAX_SKILL_CALLS: usize = 16;
pub(crate) const MAX_SKILL_ENTRIES: usize = 1024;
pub(crate) const MAX_SKILLS: usize = 256;
pub(crate) const MAX_SKILL_READ: usize = 8 * 1024 * 1024;

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn json_digest(value: &impl Serialize) -> String {
    digest(&serde_json::to_vec(value).expect("Skills protocol is serializable"))
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillScope {
    pub(crate) target: AgentSessionTarget,
    pub(crate) root: String,
    pub(crate) root_identity: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillDiagnostic {
    pub(crate) path: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

impl SkillDiagnostic {
    pub(crate) fn new(path: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillEntry {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) relative_path: String,
    pub(crate) resource_base: String,
    pub(crate) model_invocable: bool,
    pub(crate) user_invocable: bool,
    pub(crate) file_hash: String,
    pub(crate) instruction_hash: String,
    pub(crate) extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillDefinition {
    pub(crate) entry: SkillEntry,
    pub(crate) instructions: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillObservationStatus {
    Complete,
    Incomplete,
    Unavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillSnapshot {
    pub(crate) protocol_version: u32,
    pub(crate) scope: SkillScope,
    pub(crate) entries: Vec<SkillEntry>,
    pub(crate) snapshot_revision: String,
}

impl SkillSnapshot {
    pub(crate) fn new(scope: SkillScope, definitions: &[SkillDefinition]) -> Self {
        let entries: Vec<_> = definitions.iter().map(|d| d.entry.clone()).collect();
        let snapshot_revision = json_digest(&(&scope, &entries));
        Self {
            protocol_version: SKILL_PROTOCOL,
            scope,
            entries,
            snapshot_revision,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.protocol_version != SKILL_PROTOCOL
            || self.entries.len() > MAX_SKILLS
            || self.snapshot_revision != json_digest(&(&self.scope, &self.entries))
        {
            return Err("invalid Skills snapshot version, limit or digest".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillObservation {
    pub(crate) protocol_version: u32,
    pub(crate) status: SkillObservationStatus,
    pub(crate) snapshot: Option<SkillSnapshot>,
    pub(crate) diagnostics: Vec<SkillDiagnostic>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillInvocationKind {
    Model,
    User,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillProvenance {
    pub(crate) protocol_version: u32,
    pub(crate) renderer_version: u32,
    pub(crate) provider_identity: String,
    pub(crate) scope: SkillScope,
    pub(crate) relative_path: String,
    pub(crate) resource_base: String,
    pub(crate) invocation: SkillInvocationKind,
    pub(crate) catalog_revision: String,
    pub(crate) file_hash: String,
    pub(crate) instruction_hash: String,
    pub(crate) message_ids: Vec<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) call_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoadedSkill {
    pub(crate) name: String,
    pub(crate) instructions: String,
    pub(crate) provenance: SkillProvenance,
    pub(crate) rendered: String,
    pub(crate) rendered_hash: String,
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

impl LoadedSkill {
    pub(crate) fn render(name: &str, instructions: &str, provenance: &SkillProvenance) -> String {
        format!("<skill_content name=\"{}\">\n<skill_resources>{}</skill_resources>\n<skill_provenance>{}</skill_provenance>\n<skill_instructions>{}</skill_instructions>\n</skill_content>",
            escape(name), escape(&format!("{}:{}:{}; resource base {}; resources require existing tool authorization", provenance.scope.target.kind, provenance.scope.target.target_id, provenance.scope.root, provenance.resource_base)),
            escape(&serde_json::to_string(provenance).expect("provenance JSON")), escape(instructions))
    }

    pub(crate) fn new(
        name: String,
        instructions: String,
        provenance: SkillProvenance,
    ) -> Result<Self, String> {
        let rendered = Self::render(&name, &instructions, &provenance);
        let loaded = Self {
            name,
            instructions,
            provenance,
            rendered_hash: digest(rendered.as_bytes()),
            rendered,
        };
        loaded.validate()?;
        unchanged_by_redaction(&loaded)?;
        Ok(loaded)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.provenance.protocol_version != SKILL_PROTOCOL
            || self.provenance.renderer_version != 1
            || !valid_name(&self.name)
            || self.rendered.len() > MAX_SKILL_RENDERED
            || self.instructions.len() > MAX_SKILL_FILE
            || serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 240 * 1024
            || self.provenance.instruction_hash != digest(self.instructions.as_bytes())
            || self.rendered != Self::render(&self.name, &self.instructions, &self.provenance)
            || self.rendered_hash != digest(self.rendered.as_bytes())
        {
            return Err("invalid complete Skill payload: version, bounds or hash".into());
        }
        Ok(())
    }
}

pub(crate) fn unchanged_by_redaction(value: &impl Serialize) -> Result<(), String> {
    let value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    if crate::redaction::redact_json_value(&value) != value {
        return Err("Skill content requires redaction; complete load rejected".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillCatalogPublication {
    pub(crate) scope: Option<SkillScope>,
    pub(crate) model_catalog_digest: String,
    pub(crate) content: String,
}

impl SkillCatalogPublication {
    pub(crate) fn new(snapshot: Option<&SkillSnapshot>, model_enabled: bool) -> Self {
        let entries: Vec<_> = snapshot
            .filter(|_| model_enabled)
            .into_iter()
            .flat_map(|s| &s.entries)
            .filter(|e| e.model_invocable)
            .map(|e| (&e.name, &e.description))
            .collect();
        let scope = snapshot.map(|s| s.scope.clone());
        let model_catalog_digest = json_digest(&(&scope, &entries));
        let mut content = String::from("<skill_catalog replacement=\"complete\">\nSkills are instructions, not permission. Use skill({name}) only for listed model skills.\n");
        for (name, description) in entries {
            content.push_str(&format!("{}: {}\n", name, escape(description)));
        }
        content.push_str("</skill_catalog>");
        Self {
            scope,
            model_catalog_digest,
            content,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillSlashOutcome {
    pub(crate) name: String,
    pub(crate) message_ids: Vec<String>,
    pub(crate) loaded: Option<LoadedSkill>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillStepPrepared {
    pub(crate) protocol_version: u32,
    pub(crate) message_ids: Vec<String>,
    pub(crate) catalog: Option<SkillCatalogPublication>,
    pub(crate) outcomes: Vec<SkillSlashOutcome>,
}

impl SkillStepPrepared {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.protocol_version != SKILL_PROTOCOL || self.outcomes.len() > MAX_SKILL_CALLS {
            return Err("invalid Skills preparation version or call limit".into());
        }
        let mut bytes = self.catalog.as_ref().map_or(0, |c| c.content.len());
        let mut names = BTreeSet::new();
        for outcome in &self.outcomes {
            if !valid_name(&outcome.name)
                || !names.insert(&outcome.name)
                || outcome.loaded.is_some() == outcome.error.is_some()
                || outcome.message_ids.is_empty()
                || outcome
                    .message_ids
                    .iter()
                    .any(|id| !self.message_ids.contains(id))
            {
                return Err("invalid slash outcome".into());
            }
            if let Some(loaded) = &outcome.loaded {
                if loaded.name != outcome.name
                    || loaded.provenance.invocation != SkillInvocationKind::User
                    || loaded.provenance.message_ids != outcome.message_ids
                {
                    return Err("slash provenance does not match outcome".into());
                }
                loaded.validate()?;
                bytes += loaded.rendered.len();
            }
        }
        if bytes > MAX_SKILL_STEP {
            return Err("Skills step input exceeds complete batch limit".into());
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 240 * 1024 {
            return Err("Skills preparation exceeds durable event limit".into());
        }
        unchanged_by_redaction(self)
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

pub(crate) fn parse_skill(
    path: &str,
    bytes: &[u8],
) -> Result<(SkillDefinition, Vec<SkillDiagnostic>), String> {
    if bytes.len() > MAX_SKILL_FILE {
        return Err("Skill file exceeds byte limit".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Skill file must be UTF-8")?;
    let first = text.find('\n').ok_or("missing Skill frontmatter")?;
    if text[..first].trim_end_matches('\r') != "---" {
        return Err("Skill frontmatter must start with ---".into());
    }
    let mut end = None;
    let mut offset = first + 1;
    for line in text[offset..].split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let (yaml_end, body_start) = end.ok_or("missing closing Skill frontmatter delimiter")?;
    if text[first + 1..yaml_end]
        .lines()
        .any(|line| line.trim_end_matches('\r') == "...")
    {
        return Err("explicit YAML document end is not allowed in Skill frontmatter".into());
    }
    // serde_yaml Mapping deserialization rejects duplicate keys, multiple documents, and non-mappings.
    let metadata: serde_yaml::Mapping = serde_yaml::from_str(&text[first + 1..yaml_end])
        .map_err(|e| format!("invalid Skill YAML: {e}"))?;
    let key = |name: &str| serde_yaml::Value::String(name.into());
    let string = |name: &str| -> Result<String, String> {
        metadata
            .get(key(name))
            .and_then(serde_yaml::Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("{name} must be a non-empty YAML string"))
    };
    let boolean = |name: &str, default: bool| -> Result<bool, String> {
        match metadata.get(key(name)) {
            None => Ok(default),
            Some(serde_yaml::Value::Bool(v)) => Ok(*v),
            _ => Err(format!("{name} must be a YAML boolean")),
        }
    };
    for (legacy, canonical) in [
        ("userInvocable", "user-invocable"),
        ("disableModelInvocation", "disable-model-invocation"),
    ] {
        if metadata.contains_key(key(legacy)) {
            return Err(format!("use {canonical}, not legacy {legacy}"));
        }
    }
    let name = string("name")?;
    if !valid_name(&name) {
        return Err("invalid Skill name".into());
    }
    let description = string("description")?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect();
    let model_invocable = !boolean("disable-model-invocation", false)?;
    let user_invocable = boolean("user-invocable", true)?;
    let mut extensions = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for (field, value) in metadata {
        let field = field
            .as_str()
            .ok_or("Skill metadata keys must be strings")?;
        if [
            "name",
            "description",
            "disable-model-invocation",
            "user-invocable",
        ]
        .contains(&field)
        {
            continue;
        }
        extensions.insert(
            field.into(),
            serde_json::to_value(value).map_err(|_| "unsupported metadata")?,
        );
        diagnostics.push(SkillDiagnostic::new(
            path,
            "unknownMetadata",
            format!("{field} retained as inert metadata; grants no permission"),
        ));
    }
    if serde_json::to_vec(&extensions)
        .map_err(|e| e.to_string())?
        .len()
        > 8192
        || diagnostics.len() > 32
    {
        return Err("Skill metadata exceeds bound".into());
    }
    let instructions = text[body_start..].to_string();
    let entry = SkillEntry {
        name,
        description,
        relative_path: path.into(),
        resource_base: path
            .rsplit_once('/')
            .map_or(".", |(parent, _)| parent)
            .into(),
        model_invocable,
        user_invocable,
        file_hash: digest(bytes),
        instruction_hash: digest(instructions.as_bytes()),
        extensions,
    };
    Ok((
        SkillDefinition {
            entry,
            instructions,
        },
        diagnostics,
    ))
}

pub(crate) fn slash_candidates(
    messages: &[AgentInboxMessage],
) -> Result<Vec<(String, Vec<String>)>, String> {
    let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
    for message in messages.iter().filter(|m| direct_skill_input(m)) {
        for token in message.content.split_whitespace() {
            let Some(name) = token.strip_prefix('/').filter(|name| valid_name(name)) else {
                continue;
            };
            if let Some((_, ids)) = candidates.iter_mut().find(|(n, _)| n == name) {
                if !ids.contains(&message.message_id) {
                    ids.push(message.message_id.clone());
                }
            } else {
                candidates.push((name.into(), vec![message.message_id.clone()]));
            }
        }
    }
    if candidates.len() > MAX_SKILL_CALLS {
        return Err("Skills step exceeds unique invocation limit".into());
    }
    Ok(candidates)
}

pub(crate) fn direct_skill_input(message: &AgentInboxMessage) -> bool {
    message.source.kind == AgentMessageSourceKind::User
        && message.source.producer_id == "shellspan-user"
        && message.client_submission_id.is_some()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillArguments {
    pub(crate) name: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(extra: &str, body: &str) -> Result<(SkillDefinition, Vec<SkillDiagnostic>), String> {
        parse_skill(
            ".agents/skills/sample/SKILL.md",
            format!("---\nname: sample\ndescription: Useful instructions\n{extra}---\n{body}")
                .as_bytes(),
        )
    }
    #[test]
    fn skill_yaml_policy_four_combinations_and_defaults() {
        for model in [true, false] {
            for user in [true, false] {
                let (d, _) = parse(
                    &format!(
                        "disable-model-invocation: {}\nuser-invocable: {user}\n",
                        !model
                    ),
                    "\n  full body \n",
                )
                .unwrap();
                assert_eq!(
                    (d.entry.model_invocable, d.entry.user_invocable),
                    (model, user)
                );
                assert_eq!(d.instructions, "\n  full body \n");
            }
        }
        let d = parse("", "body").unwrap().0;
        assert!(d.entry.model_invocable && d.entry.user_invocable);
    }
    #[test]
    fn skill_yaml_rejects_ambiguous_booleans_legacy_duplicates_and_invalid_types() {
        for field in ["disable-model-invocation", "user-invocable"] {
            for value in [
                "\"false\"",
                "yes",
                "no",
                "on",
                "off",
                "0",
                "1",
                "null",
                "[]",
                "{}",
            ] {
                assert!(
                    parse(&format!("{field}: {value}\n"), "body").is_err(),
                    "{field}: {value}"
                );
            }
        }
        for extra in [
            "userInvocable: false\n",
            "disableModelInvocation: true\n",
            "name: duplicate\n",
            "[broken",
            "description: 42\n",
            "description: null\n",
            "42: extra\n",
        ] {
            assert!(parse(extra, "body").is_err(), "{extra}");
        }
        assert!(parse_skill("x", b"---\n[]\n---\nbody").is_err());
        assert!(parse_skill(
            "x",
            b"---\nname: x\ndescription: d\n...\n---\nname: y\n---\nbody"
        )
        .is_err());
    }
    #[test]
    fn skill_unknown_metadata_is_inert_and_crlf_body_is_exact() {
        let (d, notes) = parse("allowed-tools: Bash(*)\ncustom: [a, b]\n", "body").unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(d.entry.extensions.len(), 2);
        let text =
            b"---\r\nname: crlf\r\ndescription: |\r\n  first\r\n  second\r\n---\r\n\r\nbody  \r\n";
        let (d, _) = parse_skill("crlf.md", text).unwrap();
        assert_eq!(d.instructions, "\r\nbody  \r\n");
        assert_eq!(d.entry.description, "first second");
    }
    #[test]
    fn skill_slash_exact_whitespace_identity_and_limit() {
        let mut m = AgentInboxMessage {
            images: Vec::new(),
            message_id: "m".into(),
            client_submission_id: Some("ingress".into()),
            content: "/first text\u{2003}/second /first /not. path/a /absolute/path 1/2 /third"
                .into(),
            source: super::super::AgentMessageSource::user(),
        };
        assert_eq!(
            slash_candidates(&[m.clone()])
                .unwrap()
                .iter()
                .map(|v| v.0.as_str())
                .collect::<Vec<_>>(),
            ["first", "second", "third"]
        );
        for kind in [
            AgentMessageSourceKind::Runtime,
            AgentMessageSourceKind::Plugin,
            AgentMessageSourceKind::Form,
            AgentMessageSourceKind::SkillInvocation,
            AgentMessageSourceKind::SessionReference,
        ] {
            m.source.kind = kind;
            assert!(slash_candidates(&[m.clone()]).unwrap().is_empty());
        }
        m.source = super::super::AgentMessageSource::user();
        m.client_submission_id = None;
        assert!(slash_candidates(&[m.clone()]).unwrap().is_empty());
        m.client_submission_id = Some("i".into());
        m.content = (0..17).map(|i| format!("/s-{i} ")).collect();
        assert!(slash_candidates(&[m]).is_err());
    }
    #[test]
    fn skill_parser_file_and_metadata_bounds() {
        let prefix = b"---\nname: sample\ndescription: d\n---\n";
        for n in [MAX_SKILL_FILE - 1, MAX_SKILL_FILE, MAX_SKILL_FILE + 1] {
            let mut text = prefix.to_vec();
            text.resize(n, b'x');
            assert_eq!(parse_skill("sample.md", &text).is_ok(), n <= MAX_SKILL_FILE);
        }
        assert!(parse(&format!("extra: {}\n", "x".repeat(8193)), "body").is_err());
        assert!(parse_skill("bad.md", &[255]).is_err());
    }
}
