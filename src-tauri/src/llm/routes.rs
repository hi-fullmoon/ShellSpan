//! Versioned, secret-free connection documents. Publication is a single swap after commit.
use super::{
    catalog::{self, ModelDefinition},
    config::{AiProviderConfig, AiProviderKind},
};
use crate::{
    db::Database,
    keychain::{CredentialManager, AI_KEY_SERVICE},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex},
};

pub(crate) const ROUTES_KEY: &str = "llm.routes.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelSelection {
    pub route_id: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum RouteAuth {
    None,
    Keychain { reference: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RouteTimeouts {
    pub request_headers_ms: u64,
    pub first_byte_ms: u64,
    pub stream_idle_ms: u64,
}
impl Default for RouteTimeouts {
    fn default() -> Self {
        Self {
            request_headers_ms: 30_000,
            first_byte_ms: 30_000,
            stream_idle_ms: 300_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderRoute {
    pub id: String,
    pub revision: u64,
    pub display_name: String,
    pub adapter_id: String,
    pub base_url: String,
    pub auth: RouteAuth,
    pub replay_domain_id: String,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub models: Option<BTreeMap<String, ModelDefinition>>,
    #[serde(default)]
    pub model_overrides: Option<BTreeMap<String, ModelDefinition>>,
    #[serde(default)]
    pub defaults: Option<ModelSelection>,
    pub retry_policy: crate::agent_runtime::RetryPolicy,
    #[serde(default)]
    pub timeouts: RouteTimeouts,
}
impl ProviderRoute {
    pub fn kind(&self) -> Result<AiProviderKind, String> {
        match self.adapter_id.as_str() {
            "responses" => Ok(AiProviderKind::OpenAi),
            "chat-completions" => Ok(AiProviderKind::OpenAiCompatible),
            "ollama" => Ok(AiProviderKind::Ollama),
            "anthropic-messages" => Ok(AiProviderKind::AnthropicMessages),
            _ => Err("UNKNOWN_ADAPTER".into()),
        }
    }
    pub fn model_catalog(&self) -> Result<BTreeMap<String, ModelDefinition>, String> {
        if self.models.is_some() && self.model_overrides.is_some() {
            return Err(
                "INVALID_OVERRIDE: models and modelOverrides are mutually exclusive".into(),
            );
        }
        let mut models = match &self.models {
            Some(models) => models.clone(),
            None => catalog::preset_models(
                self.preset_id.as_deref().ok_or("UNKNOWN_PROFILE")?,
                self.kind()?,
            )?,
        };
        if let Some(overrides) = &self.model_overrides {
            for (id, definition) in overrides {
                if !models.contains_key(id) {
                    return Err(format!("INVALID_OVERRIDE: {id}"));
                }
                models.insert(id.clone(), definition.clone());
            }
        }
        if models.is_empty() {
            return Err("UNKNOWN_MODEL: empty route catalog".into());
        }
        for (id, definition) in &models {
            catalog::validate_definition(id, definition, self.kind()?)?;
        }
        Ok(models)
    }
    pub fn provider(&self, selection: &ModelSelection) -> Result<AiProviderConfig, String> {
        if selection.route_id != self.id {
            return Err("UNKNOWN_ROUTE".into());
        }
        let definition = self
            .model_catalog()?
            .remove(&selection.model_id)
            .ok_or("UNKNOWN_MODEL")?;
        let provider = AiProviderConfig {
            model_definition: Some(definition),
            retry_policy: Some(self.retry_policy),
            profile: Some(
                match self.kind()? {
                    AiProviderKind::OpenAi => "openai",
                    AiProviderKind::Ollama => "ollama",
                    AiProviderKind::AnthropicMessages => "anthropic",
                    _ => "generic",
                }
                .into(),
            ),
            id: self.id.clone(),
            kind: self.kind()?,
            base_url: self.base_url.clone(),
            model: selection.model_id.clone(),
            reasoning_effort: selection.reasoning_effort.clone(),
            requires_api_key: !matches!(self.auth, RouteAuth::None),
            api_key: None,
        };
        super::config::validate_provider_config(&provider, true)?;
        Ok(provider)
    }
    fn validate(&self) -> Result<(), String> {
        super::config::validate_provider_id(&self.id)?;
        self.retry_policy.validate()?;
        if self.display_name.trim().is_empty() || self.replay_domain_id.is_empty() {
            return Err("INVALID_ROUTE".into());
        }
        if [
            self.timeouts.first_byte_ms,
            self.timeouts.request_headers_ms,
            self.timeouts.stream_idle_ms,
        ]
        .iter()
        .any(|v| *v == 0 || *v > 3_600_000)
        {
            return Err("INVALID_TIMEOUT".into());
        }
        if let RouteAuth::Keychain { reference } = &self.auth {
            if reference.is_empty() {
                return Err("MISSING_CREDENTIAL".into());
            }
        }
        if self.kind()? == AiProviderKind::AnthropicMessages
            && !matches!(self.auth, RouteAuth::Keychain { .. })
        {
            return Err("MISSING_CREDENTIAL".into());
        }
        for id in self.model_catalog()?.keys() {
            self.provider(&ModelSelection {
                route_id: self.id.clone(),
                model_id: id.clone(),
                reasoning_effort: None,
            })?;
        }
        if let Some(selection) = &self.defaults {
            self.provider(selection)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MigrationIssue {
    pub original: Value,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RouteSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub routes: Vec<ProviderRoute>,
    pub default_selection: Option<ModelSelection>,
    pub migration_complete: bool,
    pub migration_issues: Vec<MigrationIssue>,
}
impl RouteSnapshot {
    pub fn route(&self, id: &str) -> Result<&ProviderRoute, String> {
        self.routes
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| format!("UNKNOWN_ROUTE: {id}"))
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("UNSUPPORTED_ROUTE_VERSION".into());
        }
        let mut ids = HashSet::new();
        for route in &self.routes {
            if !ids.insert(&route.id) {
                return Err("DUPLICATE_ROUTE".into());
            }
            route.validate()?;
        }
        // A deleted default remains visible as an invalid selection; never silently replace it.
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct RouteStore {
    current: Arc<Mutex<Arc<RouteSnapshot>>>,
    database: Database,
    credentials: CredentialManager,
}
impl RouteStore {
    pub fn open(database: Database, credentials: CredentialManager) -> Result<Self, String> {
        let preferences = database.load_preferences()?;
        let snapshot = match preferences.iter().find(|(k, _)| k == ROUTES_KEY) {
            Some((_, value)) => {
                serde_json::from_str(value).map_err(|e| format!("INVALID_ROUTE_DOCUMENT: {e}"))?
            }
            None => {
                let (snapshot, backup) = migrate(&preferences)?;
                database.commit_llm_routes(
                    None,
                    &serde_json::to_string(&snapshot).map_err(|e| e.to_string())?,
                    Some(&backup),
                )?;
                snapshot
            }
        };
        snapshot.validate()?;
        let store = Self {
            current: Arc::new(Mutex::new(Arc::new(snapshot))),
            database,
            credentials,
        };
        store.recover_credentials()?;
        Ok(store)
    }
    pub fn snapshot(&self) -> Result<Arc<RouteSnapshot>, String> {
        self.current
            .lock()
            .map(|v| v.clone())
            .map_err(|_| "ROUTE_STORE_UNAVAILABLE".into())
    }
    pub fn save(
        &self,
        routes: Vec<ProviderRoute>,
        default_selection: Option<ModelSelection>,
        expected_revision: u64,
        secrets: BTreeMap<String, String>,
    ) -> Result<Arc<RouteSnapshot>, String> {
        let mut current = self.current.lock().map_err(|_| "ROUTE_STORE_UNAVAILABLE")?;
        if current.revision != expected_revision {
            return Err("REVISION_CONFLICT".into());
        }
        let mut candidate = RouteSnapshot {
            schema_version: 1,
            revision: expected_revision
                .checked_add(1)
                .ok_or("REVISION_EXHAUSTED")?,
            routes,
            default_selection,
            migration_complete: current.migration_complete,
            migration_issues: current.migration_issues.clone(),
        };
        for id in secrets.keys() {
            if !candidate.routes.iter().any(|r| &r.id == id) {
                return Err("UNKNOWN_ROUTE".into());
            }
        }
        let mut staged = Vec::new();
        for route in &mut candidate.routes {
            let old = current.routes.iter().find(|r| r.id == route.id);
            // The client cannot substitute another route's credential reference.
            if let Some(old) = old {
                if route.auth != old.auth
                    && !matches!(route.auth, RouteAuth::None)
                    && !secrets.contains_key(&route.id)
                {
                    return Err("INVALID_CREDENTIAL_REFERENCE".into());
                }
            } else if !matches!(route.auth, RouteAuth::None) && !secrets.contains_key(&route.id) {
                return Err("MISSING_CREDENTIAL".into());
            }
            let route_changed = old.is_none_or(|old| {
                old.display_name != route.display_name
                    || old.base_url != route.base_url
                    || old.adapter_id != route.adapter_id
                    || old.auth != route.auth
                    || old.preset_id != route.preset_id
                    || old.models != route.models
                    || old.model_overrides != route.model_overrides
                    || old.defaults != route.defaults
                    || old.retry_policy != route.retry_policy
                    || old.timeouts != route.timeouts
            });
            let identity_changed = old.is_none_or(|old| {
                old.base_url != route.base_url
                    || old.adapter_id != route.adapter_id
                    || old.auth != route.auth
                    || old.preset_id != route.preset_id
                    || old.models != route.models
                    || old.model_overrides != route.model_overrides
            });
            route.revision = old.map_or(1, |old| {
                if route_changed || secrets.contains_key(&route.id) {
                    old.revision.saturating_add(1)
                } else {
                    old.revision
                }
            });
            route.replay_domain_id = if identity_changed || secrets.contains_key(&route.id) {
                uuid::Uuid::new_v4().to_string()
            } else {
                old.unwrap().replay_domain_id.clone()
            };
            if let Some(secret) = secrets.get(&route.id) {
                if secret.trim().is_empty() {
                    return Err("MISSING_CREDENTIAL".into());
                }
                let reference = format!("llm-{}", uuid::Uuid::new_v4());
                route.auth = RouteAuth::Keychain {
                    reference: reference.clone(),
                };
                staged.push((reference, secret));
            }
        }
        candidate.validate()?;
        if let Some(selection) = &candidate.default_selection {
            candidate.route(&selection.route_id)?.provider(selection)?;
        }
        let raw = serde_json::to_string(&candidate).map_err(|e| e.to_string())?;
        // Journal before touching keychain: a crash leaves a diagnosable pending reference.
        for (reference, _) in &staged {
            self.database.save_preferences(&[(
                format!("llm.pendingCredential.{reference}"),
                "pending".into(),
            )])?;
        }
        for (reference, secret) in &staged {
            if let Err(error) = self
                .credentials
                .set_credential(AI_KEY_SERVICE, reference, secret)
            {
                for (written, _) in &staged {
                    let _ = self.credentials.delete_credential(AI_KEY_SERVICE, written);
                }
                let keys = staged
                    .iter()
                    .map(|(r, _)| format!("llm.pendingCredential.{r}"))
                    .collect::<Vec<_>>();
                let _ = self.database.delete_preferences(&keys);
                return Err(error);
            }
        }
        if let Err(error) = self
            .database
            .commit_llm_routes(Some(expected_revision), &raw, None)
        {
            for (reference, _) in &staged {
                let _ = self
                    .credentials
                    .delete_credential(AI_KEY_SERVICE, reference);
            }
            return Err(error);
        }
        *current = Arc::new(candidate);
        // Commit and Arc publication are the success boundary. Journal cleanup
        // is recoverable maintenance; reporting failure here would lie to the
        // caller after the new revision is already durable and visible.
        let keys = staged
            .iter()
            .map(|(r, _)| format!("llm.pendingCredential.{r}"))
            .collect::<Vec<_>>();
        let _ = self.database.delete_preferences(&keys);
        Ok(current.clone())
    }
    pub fn credential(&self, route: &ProviderRoute) -> Result<Option<String>, String> {
        match &route.auth {
            RouteAuth::None => Ok(None),
            RouteAuth::Keychain { reference } => self
                .credentials
                .get_credential(AI_KEY_SERVICE, reference)?
                .filter(|v| !v.trim().is_empty())
                .map(Some)
                .ok_or_else(|| "MISSING_CREDENTIAL".into()),
        }
    }
    pub fn recover_credentials(&self) -> Result<Vec<String>, String> {
        let current = self.current.lock().map_err(|_| "ROUTE_STORE_UNAVAILABLE")?;
        let mut diagnostics = Vec::new();
        for (key, _) in self.database.load_preferences()? {
            if let Some(reference) = key.strip_prefix("llm.pendingCredential.") {
                let referenced = current.routes.iter().any(
                    |r| matches!(&r.auth, RouteAuth::Keychain { reference: r } if r == reference),
                );
                if !referenced {
                    self.credentials
                        .delete_credential(AI_KEY_SERVICE, reference)?;
                }
                diagnostics.push(format!(
                    "{reference}: {}",
                    if referenced {
                        "committed"
                    } else {
                        "unreferenced credential removed"
                    }
                ));
                self.database.delete_preferences(&[key])?;
            }
        }
        Ok(diagnostics)
    }
}

fn migrate(preferences: &[(String, String)]) -> Result<(RouteSnapshot, String), String> {
    let backup = preferences
        .iter()
        .find(|(k, _)| k == "ai.providers")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "[]".into());
    let items: Vec<Value> =
        serde_json::from_str(&backup).map_err(|e| format!("INVALID_LEGACY_CONFIGURATION: {e}"))?;
    let mut snapshot = RouteSnapshot {
        schema_version: 1,
        revision: 1,
        routes: vec![],
        default_selection: None,
        migration_complete: true,
        migration_issues: vec![],
    };
    for mut original in items.clone() {
        // Inline credentials have already been migrated by the existing startup migration.
        if let Some(object) = original.as_object_mut() {
            object.remove("apiKey");
        }
        let convert = || -> Result<ProviderRoute, String> {
            let mut object = original
                .as_object()
                .ok_or("invalid legacy provider")?
                .clone();
            let name = object
                .remove("name")
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            object.remove("preset");
            object.remove("enabled");
            object.remove("hasApiKey");
            let provider: AiProviderConfig =
                serde_json::from_value(Value::Object(object)).map_err(|e| e.to_string())?;
            let model = catalog::resolve(&provider)?;
            let selection = ModelSelection {
                route_id: provider.id.clone(),
                model_id: provider.model.clone(),
                reasoning_effort: provider.reasoning_effort.clone(),
            };
            let route = ProviderRoute {
                id: provider.id.clone(),
                revision: 1,
                display_name: if name.is_empty() {
                    provider.id.clone()
                } else {
                    name
                },
                adapter_id: adapter_id(provider.kind).into(),
                base_url: provider.base_url.clone(),
                auth: if provider.requires_api_key {
                    RouteAuth::Keychain {
                        reference: provider.id,
                    }
                } else {
                    RouteAuth::None
                },
                replay_domain_id: uuid::Uuid::new_v4().to_string(),
                preset_id: Some(model.profile.clone()),
                models: Some(BTreeMap::from([(provider.model, model.definition)])),
                model_overrides: None,
                defaults: Some(selection),
                retry_policy: provider.retry_policy.unwrap_or_default(),
                timeouts: RouteTimeouts::default(),
            };
            route.validate()?;
            Ok(route)
        };
        match convert() {
            Ok(route) if !snapshot.routes.iter().any(|r| r.id == route.id) => {
                snapshot.routes.push(route)
            }
            Ok(_) => snapshot.migration_issues.push(MigrationIssue {
                original,
                error: "DUPLICATE_ROUTE".into(),
            }),
            Err(error) => snapshot
                .migration_issues
                .push(MigrationIssue { original, error }),
        }
    }
    let default_id = preferences
        .iter()
        .find(|(k, _)| k == "ai.defaultProviderId")
        .and_then(|(_, v)| serde_json::from_str::<String>(v).ok());
    snapshot.default_selection = default_id.and_then(|id| {
        snapshot
            .routes
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| r.defaults.clone())
            .or_else(|| {
                items
                    .iter()
                    .find(|v| v["id"] == id)
                    .and_then(|v| v["model"].as_str())
                    .map(|model_id| ModelSelection {
                        route_id: id,
                        model_id: model_id.into(),
                        reasoning_effort: None,
                    })
            })
    });
    Ok((snapshot, backup))
}

pub(crate) fn adapter_id(kind: AiProviderKind) -> &'static str {
    match kind {
        AiProviderKind::OpenAi => "responses",
        AiProviderKind::OpenAiCompatible => "chat-completions",
        AiProviderKind::Ollama => "ollama",
        AiProviderKind::AnthropicMessages => "anthropic-messages",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy(id: &str, model: &str) -> Value {
        serde_json::json!({"id":id,"name":"Same name","preset":"ollama","profile":"ollama","kind":"ollama","baseUrl":"http://127.0.0.1:11434","model":model,"requiresApiKey":false,"retryPolicy":{"maxAttempts":3,"initialDelayMs":250,"maxDelayMs":4000,"maxServerDelayMs":30000,"jitterRatio":0.2}})
    }
    #[test]
    fn migration_keeps_connections_separate_and_default_selection() {
        let raw = serde_json::to_string(&vec![legacy("a", "qwen3"), legacy("b", "qwen3")]).unwrap();
        let prefs = vec![
            ("ai.providers".into(), raw.clone()),
            (
                "ai.defaultProviderId".into(),
                serde_json::to_string("b").unwrap(),
            ),
        ];
        let (result, backup) = migrate(&prefs).unwrap();
        assert_eq!(backup, raw);
        assert_eq!(result.routes.len(), 2);
        assert_eq!(result.routes[0].display_name, result.routes[1].display_name);
        assert_eq!(result.default_selection.unwrap().route_id, "b");
    }
    #[test]
    fn invalid_legacy_is_preserved_for_repair() {
        let bad = serde_json::json!({"id":"broken","name":"Broken","preset":"custom","kind":"unknown","baseUrl":"x","model":"x","requiresApiKey":false});
        let raw = serde_json::to_string(&vec![bad.clone()]).unwrap();
        let (result, _) = migrate(&[("ai.providers".into(), raw)]).unwrap();
        assert!(result.routes.is_empty());
        assert_eq!(result.migration_issues[0].original, bad);
    }
    #[test]
    fn validates_mutual_exclusion_duplicate_and_unknown_adapter() {
        let mut route = ProviderRoute {
            id: "r".into(),
            revision: 1,
            display_name: "R".into(),
            adapter_id: "bad".into(),
            base_url: "https://example.com".into(),
            auth: RouteAuth::None,
            replay_domain_id: "domain".into(),
            preset_id: Some("generic".into()),
            models: None,
            model_overrides: None,
            defaults: None,
            retry_policy: Default::default(),
            timeouts: Default::default(),
        };
        assert_eq!(route.validate().unwrap_err(), "UNKNOWN_ADAPTER");
        route.adapter_id = "chat-completions".into();
        let definition = catalog::fixture_definition(AiProviderKind::OpenAiCompatible, 8192);
        route.models = Some(BTreeMap::from([("x".into(), definition.clone())]));
        route.model_overrides = Some(BTreeMap::from([("x".into(), definition)]));
        assert!(route.validate().unwrap_err().contains("mutually exclusive"));
    }

    #[test]
    fn anthropic_routes_require_versioned_keychain_credentials() {
        let definition = catalog::fixture_definition(AiProviderKind::AnthropicMessages, 8192);
        let mut route = ProviderRoute {
            id: "anthropic".into(),
            revision: 1,
            display_name: "Anthropic".into(),
            adapter_id: "anthropic-messages".into(),
            base_url: "https://api.anthropic.com".into(),
            auth: RouteAuth::None,
            replay_domain_id: "domain".into(),
            preset_id: None,
            models: Some(BTreeMap::from([("fixture-model".into(), definition)])),
            model_overrides: None,
            defaults: None,
            retry_policy: Default::default(),
            timeouts: Default::default(),
        };
        assert_eq!(route.validate().unwrap_err(), "MISSING_CREDENTIAL");
        route.auth = RouteAuth::Keychain {
            reference: "pending".into(),
        };
        route.validate().unwrap();
        assert_eq!(route.kind().unwrap(), AiProviderKind::AnthropicMessages);
    }
    #[test]
    fn database_compare_and_swap_allows_only_one_stale_writer() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let empty = RouteSnapshot {
            schema_version: 1,
            revision: 1,
            routes: vec![],
            default_selection: None,
            migration_complete: true,
            migration_issues: vec![],
        };
        let raw = serde_json::to_string(&empty).unwrap();
        db.commit_llm_routes(None, &raw, None).unwrap();
        let mut next = empty;
        next.revision = 2;
        let next = serde_json::to_string(&next).unwrap();
        db.commit_llm_routes(Some(1), &next, None).unwrap();
        assert_eq!(
            db.commit_llm_routes(Some(1), &next, None).unwrap_err(),
            "REVISION_CONFLICT"
        );
    }

    fn keyed_route(id: &str) -> ProviderRoute {
        let definition = catalog::fixture_definition(AiProviderKind::OpenAiCompatible, 8192);
        ProviderRoute {
            id: id.into(),
            revision: 1,
            display_name: "Versioned key route".into(),
            adapter_id: "chat-completions".into(),
            base_url: "https://example.com".into(),
            auth: RouteAuth::Keychain {
                reference: "pending".into(),
            },
            replay_domain_id: "pending".into(),
            preset_id: None,
            models: Some(BTreeMap::from([("fixture-model".into(), definition)])),
            model_overrides: None,
            defaults: Some(ModelSelection {
                route_id: id.into(),
                model_id: "fixture-model".into(),
                reasoning_effort: None,
            }),
            retry_policy: Default::default(),
            timeouts: Default::default(),
        }
    }

    #[test]
    fn secret_rotation_versions_references_and_preserves_the_frozen_route() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db, credentials).unwrap();
        let first = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "old-secret".into())]),
            )
            .unwrap();
        let frozen = first.route("route").unwrap().clone();
        let old_reference = match &frozen.auth {
            RouteAuth::Keychain { reference } => reference.clone(),
            _ => panic!(),
        };
        let second = store
            .save(
                first.routes.clone(),
                first.default_selection.clone(),
                first.revision,
                BTreeMap::from([("route".into(), "new-secret".into())]),
            )
            .unwrap();
        let current = second.route("route").unwrap();
        let new_reference = match &current.auth {
            RouteAuth::Keychain { reference } => reference,
            _ => panic!(),
        };
        assert_ne!(&old_reference, new_reference);
        assert_eq!(
            store.credential(&frozen).unwrap().as_deref(),
            Some("old-secret")
        );
        assert_eq!(
            store.credential(current).unwrap().as_deref(),
            Some("new-secret")
        );
    }

    #[test]
    fn replay_domain_ignores_display_timeouts_but_rotates_for_protocol_identity() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db, credentials).unwrap();
        let first = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "secret".into())]),
            )
            .unwrap();
        let first_domain = first.route("route").unwrap().replay_domain_id.clone();
        let mut cosmetic = first.routes.clone();
        cosmetic[0].display_name = "Renamed".into();
        cosmetic[0].timeouts.stream_idle_ms += 1;
        let second = store
            .save(cosmetic, None, first.revision, BTreeMap::new())
            .unwrap();
        assert_eq!(
            second.route("route").unwrap().replay_domain_id,
            first_domain
        );
        let mut protocol_change = second.routes.clone();
        protocol_change[0].preset_id = Some("generic".into());
        let third = store
            .save(protocol_change, None, second.revision, BTreeMap::new())
            .unwrap();
        assert_ne!(third.route("route").unwrap().replay_domain_id, first_domain);
    }

    #[test]
    fn missing_versioned_credential_fails_closed_and_recovery_removes_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db.clone(), credentials.clone()).unwrap();
        let snapshot = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "secret".into())]),
            )
            .unwrap();
        let route = snapshot.route("route").unwrap();
        let reference = match &route.auth {
            RouteAuth::Keychain { reference } => reference.clone(),
            _ => panic!(),
        };
        credentials
            .delete_credential(AI_KEY_SERVICE, &reference)
            .unwrap();
        assert_eq!(store.credential(route).unwrap_err(), "MISSING_CREDENTIAL");
        credentials
            .set_credential(AI_KEY_SERVICE, "orphan", "orphan-secret")
            .unwrap();
        db.save_preferences(&[("llm.pendingCredential.orphan".into(), "pending".into())])
            .unwrap();
        drop(store);
        let reopened = RouteStore::open(db.clone(), credentials.clone()).unwrap();
        assert!(reopened.snapshot().is_ok());
        assert_eq!(
            credentials
                .get_credential(AI_KEY_SERVICE, "orphan")
                .unwrap(),
            None
        );
        assert!(!db
            .load_preferences()
            .unwrap()
            .iter()
            .any(|(key, _)| key == "llm.pendingCredential.orphan"));
    }

    #[test]
    fn keychain_to_none_is_explicit_and_does_not_change_the_frozen_route() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db, credentials).unwrap();
        let keyed = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "secret".into())]),
            )
            .unwrap();
        let frozen = keyed.route("route").unwrap().clone();
        let mut updated = frozen.clone();
        updated.auth = RouteAuth::None;
        let anonymous = store
            .save(vec![updated], None, keyed.revision, BTreeMap::new())
            .unwrap();
        assert_eq!(
            store.credential(anonymous.route("route").unwrap()).unwrap(),
            None
        );
        assert_eq!(
            store.credential(&frozen).unwrap().as_deref(),
            Some("secret")
        );
    }
}
