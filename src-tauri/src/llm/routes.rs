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
    pub preset_id: String,
    #[serde(default)]
    pub models: Option<BTreeMap<String, ModelDefinition>>,
    #[serde(default)]
    pub model_overrides: Option<BTreeMap<String, ModelDefinition>>,
    #[serde(default)]
    pub defaults: Option<ModelSelection>,
    pub retry_policy: crate::agent_runtime::RetryPolicy,
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
            None => catalog::preset_models(&self.preset_id, self.kind()?)?,
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
        let kind = self.kind()?;
        let mut models = self.model_catalog()?;
        let definition = models
            .remove(&selection.model_id)
            .or_else(|| {
                self.models
                    .is_none()
                    .then(|| catalog::alias_target(&self.preset_id, &selection.model_id))
                    .flatten()
                    .and_then(|target| models.remove(target))
            })
            .ok_or("UNKNOWN_MODEL")?;
        let provider = AiProviderConfig {
            model_definition: Some(definition),
            // Retry recovery is an application policy, not a route or model setting.
            // Keep the route field wire-compatible, but always use the runtime default.
            retry_policy: None,
            // Preserve the route's capability profile. OpenAI-compatible presets
            // share an adapter, but their built-in model catalogs and compatibility
            // behavior are profile-specific (for example, kimi/k3 is not
            // generic/k3).
            profile: self.preset_id.clone(),
            id: self.id.clone(),
            kind,
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

fn uses_legacy_minimax_builtin_catalog(route: &ProviderRoute) -> Result<bool, String> {
    if route.preset_id != "minimax" || route.model_overrides.is_some() {
        return Ok(false);
    }
    let Some(models) = &route.models else {
        return Ok(false);
    };
    let mut legacy = catalog::preset_models(&route.preset_id, route.kind()?)?;
    let Some(minimax_m3) = legacy.get_mut("MiniMax-M3") else {
        return Ok(false);
    };
    minimax_m3.context_window = 204_800;
    minimax_m3.max_output_tokens = 4_096;
    minimax_m3.image_input = catalog::Support::Unsupported;
    minimax_m3.vision = None;
    Ok(models == &legacy)
}

fn migrate_legacy_builtin_catalogs(snapshot: &mut RouteSnapshot) -> Result<bool, String> {
    let mut changed = false;
    for route in &mut snapshot.routes {
        if !uses_legacy_minimax_builtin_catalog(route)? {
            continue;
        }
        route.models = None;
        route.revision = route.revision.checked_add(1).ok_or("REVISION_EXHAUSTED")?;
        route.replay_domain_id = uuid::Uuid::new_v4().to_string();
        changed = true;
    }
    if changed {
        snapshot.revision = snapshot
            .revision
            .checked_add(1)
            .ok_or("REVISION_EXHAUSTED")?;
    }
    Ok(changed)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RouteSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub routes: Vec<ProviderRoute>,
    pub default_selection: Option<ModelSelection>,
}
impl RouteSnapshot {
    fn initial() -> Self {
        Self {
            schema_version: 1,
            revision: 1,
            routes: Vec::new(),
            default_selection: None,
        }
    }

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
        let mut snapshot = match preferences.iter().find(|(k, _)| k == ROUTES_KEY) {
            Some((_, value)) => {
                serde_json::from_str(value).map_err(|e| format!("INVALID_ROUTE_DOCUMENT: {e}"))?
            }
            None => {
                let snapshot = RouteSnapshot::initial();
                database.commit_llm_routes(
                    None,
                    &serde_json::to_string(&snapshot).map_err(|e| e.to_string())?,
                )?;
                snapshot
            }
        };
        snapshot.validate()?;
        let previous_revision = snapshot.revision;
        if migrate_legacy_builtin_catalogs(&mut snapshot)? {
            snapshot.validate()?;
            database.commit_llm_routes(
                Some(previous_revision),
                &serde_json::to_string(&snapshot).map_err(|e| e.to_string())?,
            )?;
        }
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
            .commit_llm_routes(Some(expected_revision), &raw)
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
    include!("tests/routes.rs");
}
