#[cfg(test)]
use crate::keychain::{CredentialManager, AI_KEY_SERVICE};
pub(crate) use crate::llm::config::{validate_provider_config, AiProviderConfig};
#[cfg(test)]
pub(crate) use crate::llm::config::{AiProviderKind, AiReasoningEffort};
#[cfg(test)]
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;
#[cfg(test)]
trait AiCredentialStore {
    fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String>;
}

#[cfg(test)]
impl AiCredentialStore for CredentialManager {
    fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String> {
        self.get_credential(AI_KEY_SERVICE, provider_id)
    }
}

#[tauri::command]
pub(crate) fn ai_list_routes(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
) -> Result<crate::llm::routes::RouteSnapshot, String> {
    Ok(runtime.routes.snapshot()?.as_ref().clone())
}

#[tauri::command]
pub(crate) fn ai_get_route_api_key(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    route_id: String,
) -> Result<String, String> {
    let snapshot = runtime.routes.snapshot()?;
    let route = snapshot.route(&route_id)?;
    runtime
        .routes
        .credential(route)?
        .ok_or_else(|| "MISSING_CREDENTIAL".to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveRouteDocumentInput {
    routes: Vec<crate::llm::routes::ProviderRoute>,
    #[serde(default)]
    default_selection: Option<crate::llm::routes::ModelSelection>,
    expected_revision: u64,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

#[tauri::command]
pub(crate) fn ai_save_routes(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    input: SaveRouteDocumentInput,
) -> Result<crate::llm::routes::RouteSnapshot, String> {
    Ok(runtime
        .routes
        .save(
            input.routes,
            input.default_selection,
            input.expected_revision,
            input.secrets,
        )?
        .as_ref()
        .clone())
}

#[tauri::command]
pub(crate) fn ai_list_route_models(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    route_id: String,
) -> Result<RouteModelsResult, String> {
    let snapshot = runtime.routes.snapshot()?;
    let route = snapshot.route(&route_id)?;
    let mut model_ids = route.model_catalog()?.into_keys().collect::<Vec<_>>();
    for selection in [route.defaults.as_ref(), snapshot.default_selection.as_ref()]
        .into_iter()
        .flatten()
        .filter(|selection| selection.route_id == route_id)
    {
        if !model_ids.contains(&selection.model_id) {
            model_ids.push(selection.model_id.clone());
        }
    }
    let models = model_ids
        .iter()
        .map(|model_id| {
            crate::llm::catalog::resolve(&route.provider(&crate::llm::routes::ModelSelection {
                route_id: route_id.clone(),
                model_id: model_id.clone(),
                reasoning_effort: None,
            })?)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RouteModelsResult {
        revision: snapshot.revision,
        models,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteModelsResult {
    revision: u64,
    models: Vec<crate::llm::catalog::ResolvedModel>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveSelectionInput {
    selection: crate::llm::routes::ModelSelection,
    expected_revision: u64,
}

#[tauri::command]
pub(crate) fn ai_resolve_selection(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    input: ResolveSelectionInput,
) -> Result<crate::llm::catalog::ResolvedModel, String> {
    let snapshot = runtime.routes.snapshot()?;
    let route = snapshot.route(&input.selection.route_id)?;
    if route.revision != input.expected_revision {
        return Err("REVISION_CONFLICT".into());
    }
    crate::llm::catalog::resolve(&route.provider(&input.selection)?)
}

#[tauri::command]
pub(crate) async fn ai_list_models(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    provider: AiProviderConfig,
) -> Result<Vec<crate::llm::discovery::DiscoveredModel>, String> {
    validate_provider_config(&provider, false)?;
    if let Some(models) = crate::llm::discovery::catalog_models(&provider)? {
        return Ok(models);
    }
    let temporary = provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let api_key = if temporary.is_some() {
        temporary
    } else {
        let snapshot = runtime.routes.snapshot()?;
        match snapshot.routes.iter().find(|route| route.id == provider.id) {
            Some(route) => runtime.routes.credential(route)?,
            None if provider.requires_api_key => return Err("MISSING_CREDENTIAL".into()),
            None => None,
        }
    };
    crate::llm::discovery::list_models(&provider, api_key).await
}

#[cfg(test)]
fn api_key_from_store(
    credentials: &impl AiCredentialStore,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    let api_key = credentials
        .get_api_key(&provider.id)?
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    match provider.kind {
        AiProviderKind::Ollama => Ok(None),
        AiProviderKind::OpenAi => api_key
            .map(Some)
            .ok_or_else(|| "API key is required".to_string()),
        AiProviderKind::OpenAiCompatible => {
            if provider.requires_api_key && api_key.is_none() {
                Err("API key is required".to_string())
            } else {
                Ok(api_key)
            }
        }
        AiProviderKind::AnthropicMessages => api_key
            .map(Some)
            .ok_or_else(|| "API key is required".to_string()),
    }
}

#[cfg(test)]
pub(crate) fn api_key_for_provider(
    credentials: &CredentialManager,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    api_key_from_store(credentials, provider)
}

#[cfg(test)]
fn connection_test_api_key(
    credentials: &impl AiCredentialStore,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    let inline_key = provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);
    if inline_key.is_some() {
        return Ok(inline_key);
    }
    api_key_from_store(credentials, provider)
}

#[cfg(test)]
mod tests {
    include!("tests/ai.rs");
}

/// Credential-free capability DTO. Discovery and capability declaration are separate.
#[tauri::command]
pub(crate) fn ai_resolve_model(
    provider: AiProviderConfig,
) -> Result<crate::llm::catalog::ResolvedModel, String> {
    validate_provider_config(&provider, true)?;
    crate::llm::catalog::resolve(&provider)
}

#[tauri::command]
pub(crate) fn ai_model_declaration_template(
    provider: AiProviderConfig,
) -> Result<crate::llm::catalog::ModelDefinition, String> {
    crate::llm::catalog::declaration_template(&provider)
}
