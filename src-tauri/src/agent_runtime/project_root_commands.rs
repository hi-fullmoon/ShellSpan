use super::{AgentExecutionSurface, AgentSandboxContract, AgentSandboxPolicy, AgentSessionTarget};

/// Metadata-only preview uses the same canonical root calculation as session
/// freezing. It creates no session, authority, command or directory listing.
pub(crate) fn resolve_local_project_root(root: String) -> Result<String, String> {
    if root.is_empty()
        || root.len() > 4096
        || root.chars().any(char::is_control)
        || !std::path::Path::new(&root).is_absolute()
    {
        return Err("sandboxWorkspaceInvalid: absolute project directory required".into());
    }
    let target: AgentSessionTarget=serde_json::from_value(serde_json::json!({"kind":"local","targetId":"project-root-preview","sessionId":"project-root-preview","cwd":root}))
        .map_err(|_| "sandboxWorkspaceInvalid: project root target invalid")?;
    AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::ReadOnly),
        &target,
        AgentExecutionSurface::Direct,
        0,
    )?
    .root
    .ok_or_else(|| "sandboxWorkspaceMissing: select a project directory".into())
}

#[tauri::command]
pub(crate) async fn agent_runtime_resolve_local_project_root(
    root: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || resolve_local_project_root(root))
        .await
        .map_err(|_| "Project directory metadata worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_directory_preview_matches_freezing_and_rejects_files_and_relative_paths() {
        let owned = tempfile::tempdir().unwrap();
        let directory = owned.path().join("project");
        std::fs::create_dir(&directory).unwrap();
        let value = resolve_local_project_root(directory.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            std::path::Path::new(&value),
            directory.canonicalize().unwrap()
        );
        assert!(resolve_local_project_root("relative/project".into()).is_err());
        let file = owned.path().join("ordinary.txt");
        std::fs::write(&file, "ordinary content").unwrap();
        assert!(resolve_local_project_root(file.to_string_lossy().into_owned()).is_err());
        #[cfg(unix)]
        {
            let alias = owned.path().join("project-alias");
            std::os::unix::fs::symlink(&directory, &alias).unwrap();
            assert_eq!(
                resolve_local_project_root(alias.to_string_lossy().into_owned()).unwrap(),
                value
            );
        }
    }
}
