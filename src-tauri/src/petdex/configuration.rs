use super::{
    message_content::MessagePreferences,
    message_delivery::{CleanupOutcome, MessageDiagnostic, MessageTestResult},
    PetdexAdapter, PetdexCategories, PetdexDiagnostic,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Configuration {
    pub enabled: bool,
    pub categories: PetdexCategories,
    pub petdex_messages_enabled: bool,
    pub petdex_message_details_enabled: bool,
    pub locale: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigurationResult {
    effective: Configuration,
    cleanup_outcome: CleanupOutcome,
    diagnostic: PetdexDiagnostic,
    message_diagnostic: MessageDiagnostic,
}

fn persist_configuration(
    database: &crate::db::Database,
    configuration: &Configuration,
) -> Result<(), &'static str> {
    if !matches!(configuration.locale.as_str(), "zh-CN" | "en-US") {
        return Err("petdex-invalid-locale");
    }
    let value = serde_json::to_string(configuration).map_err(|_| "petdex-invalid-configuration")?;
    database
        .save_preferences(&[("petdexConfiguration".into(), value)])
        .map_err(|_| "petdex-preferences-save-failed")
}

#[tauri::command]
pub(crate) async fn petdex_configure(
    app: AppHandle,
    adapter: State<'_, PetdexAdapter>,
    configuration: Configuration,
) -> Result<ConfigurationResult, &'static str> {
    let deadline = tokio::time::Instant::now() + super::STATE_ATTEMPT_TIMEOUT;
    let _configuration =
        tokio::time::timeout_at(deadline, adapter.inner.configuration_command_lock.lock())
            .await
            .map_err(|_| "petdex-configuration-busy")?;
    if !matches!(configuration.locale.as_str(), "zh-CN" | "en-US") {
        return Err("petdex-invalid-locale");
    }
    // One SQLite row is atomic. Persist before applying; a storage failure is
    // distinct from bounded network settlement after the configuration applies.
    let saved_configuration = configuration.clone();
    let database_app = app.clone();
    tokio::task::spawn_blocking(move || {
        persist_configuration(
            &database_app.state::<crate::db::Database>(),
            &saved_configuration,
        )
    })
    .await
    .map_err(|_| "petdex-preferences-save-failed")?
    .map_err(|_| "petdex-preferences-save-failed")?;
    let closing = !configuration.enabled;
    let cleanup = if closing {
        adapter.shutdown_messages_until(deadline).await
    } else {
        CleanupOutcome::NotNeeded
    };
    adapter.set_categories(configuration.categories);
    let messages = adapter
        .configure_messages_until(
            MessagePreferences {
                petdex_messages_enabled: configuration.petdex_messages_enabled,
                petdex_message_details_enabled: configuration.petdex_message_details_enabled,
            },
            &configuration.locale,
            deadline,
        )
        .await;
    if configuration.enabled {
        let (epoch, _) = adapter.begin_message_configuration();
        adapter.start_coordinator(app.clone(), epoch);
    }
    let diagnostic = adapter.status();
    let _ = tauri::Emitter::emit(&app, super::PETDEX_STATUS_EVENT, diagnostic);
    let cleanup_outcome = if closing {
        cleanup
    } else {
        messages.cleanup_outcome
    };
    adapter
        .inner
        .messages
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .diagnostic
        .cleanup_outcome = cleanup_outcome;
    let control = adapter
        .inner
        .coordinator
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let effective = Configuration {
        enabled: adapter
            .inner
            .enabled
            .load(std::sync::atomic::Ordering::Acquire),
        categories: control.arbiter.categories,
        petdex_messages_enabled: control.arbiter.message_preferences.petdex_messages_enabled,
        petdex_message_details_enabled: control
            .arbiter
            .message_preferences
            .petdex_message_details_enabled,
        locale: configuration.locale,
    };
    drop(control);
    Ok(ConfigurationResult {
        effective,
        cleanup_outcome,
        diagnostic,
        message_diagnostic: adapter.message_diagnostic(),
    })
}

#[tauri::command]
pub(crate) fn petdex_message_diagnostic(adapter: State<'_, PetdexAdapter>) -> MessageDiagnostic {
    adapter.message_diagnostic()
}

#[tauri::command]
pub(crate) async fn petdex_test_message(
    adapter: State<'_, PetdexAdapter>,
) -> Result<MessageTestResult, &'static str> {
    Ok(adapter.test_message().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_persistence_is_atomic_and_reports_read_only_failures() {
        let root = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(&root.path().join("preferences.db")).unwrap();
        let configuration = Configuration {
            enabled: false,
            categories: PetdexCategories::default(),
            petdex_messages_enabled: true,
            petdex_message_details_enabled: false,
            locale: "en-US".into(),
        };
        persist_configuration(&database, &configuration).unwrap();
        let before = database.load_preferences().unwrap();
        assert_eq!(before.len(), 1);
        let persisted: Configuration = serde_json::from_str(&before[0].1).unwrap();
        assert!(!persisted.enabled);
        assert!(persisted.petdex_messages_enabled);
        database
            .with_connection(|connection| {
                connection
                    .execute_batch("PRAGMA query_only = ON")
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(
            persist_configuration(
                &database,
                &Configuration {
                    enabled: true,
                    ..configuration
                }
            ),
            Err("petdex-preferences-save-failed")
        );
        assert_eq!(database.load_preferences().unwrap(), before);
    }
}
