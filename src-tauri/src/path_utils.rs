use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SHELLSPAN_DATA_DIRECTORY: &str = ".shellspan";
const SHELLSPAN_DEV_DATA_DIRECTORY: &str = ".shellspan-dev";
static DATA_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn configure_data_directory(path: Option<PathBuf>) -> std::io::Result<()> {
    if let Some(path) = path {
        validate_data_directory(&path)?;
        std::fs::create_dir_all(&path)?;
        DATA_DIRECTORY.set(path.canonicalize()?).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "data directory already configured",
            )
        })?;
    }
    Ok(())
}

fn validate_data_directory(path: &Path) -> std::io::Result<()> {
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "SHELLSPAN_DATA_DIR must be an absolute directory path",
        ));
    }
    Ok(())
}

pub(crate) fn shellspan_data_dir(home_dir: &Path) -> PathBuf {
    DATA_DIRECTORY
        .get()
        .cloned()
        .unwrap_or_else(|| shellspan_data_dir_for_mode(home_dir, cfg!(debug_assertions)))
}

pub(crate) fn shellspan_log_dir(home_dir: &Path) -> PathBuf {
    shellspan_data_dir(home_dir).join("logs")
}

#[cfg(windows)]
pub(crate) fn configured_data_directory() -> Option<&'static Path> {
    DATA_DIRECTORY.get().map(PathBuf::as_path)
}

fn shellspan_data_dir_for_mode(home_dir: &Path, development: bool) -> PathBuf {
    home_dir.join(if development {
        SHELLSPAN_DEV_DATA_DIRECTORY
    } else {
        SHELLSPAN_DATA_DIRECTORY
    })
}

pub(crate) fn portable_local_path(path: &Path) -> String {
    portable_local_path_string(&path.to_string_lossy())
}

fn portable_local_path_string(path: &str) -> String {
    let without_verbatim_prefix = if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        path.to_string()
    };

    without_verbatim_prefix.replace('\\', "/")
}

/// Joins path segments for a remote POSIX filesystem, regardless of the host
/// platform. `std::path::Path::join` uses the host separator (`\` on Windows),
/// which corrupts paths sent to a POSIX SFTP server; always use this for
/// remote paths instead.
pub(crate) fn posix_join(parent: &str, child: &str) -> String {
    let child = child.trim_start_matches('/');
    if child.is_empty() {
        return parent.to_string();
    }
    if parent.is_empty() {
        return child.to_string();
    }
    format!("{}/{}", parent.trim_end_matches('/'), child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_data_directory_requires_an_absolute_path() {
        assert!(validate_data_directory(Path::new("relative-data")).is_err());
        let absolute = std::env::temp_dir().join("shellspan-explicit-data");
        assert!(validate_data_directory(&absolute).is_ok());
    }

    #[test]
    fn database_sessions_and_artifacts_share_the_mode_specific_data_root() {
        use crate::agent_runtime::{
            AgentArtifactStore, AgentExecutionSurface, AgentSessionStore, CreateAgentSessionRequest,
        };
        let home = tempfile::tempdir().unwrap();
        for development in [false, true] {
            let root = shellspan_data_dir_for_mode(home.path(), development);
            let database_path = root.join(crate::db::DATABASE_FILE_NAME);
            let _database = crate::db::Database::open(&database_path).unwrap();
            let sessions = AgentSessionStore::default();
            sessions.configure(root.clone()).unwrap();
            let id = "storage-root-check";
            sessions
                .create(CreateAgentSessionRequest {
                    session_id: id.into(),
                    task_id: id.into(),
                    goal: "Verify shared application storage".into(),
                    parent_session_id: None,
                    continued_from_session_id: None,
                    target: None,
                    permission_mode: None,
                    execution_surface: AgentExecutionSurface::Direct,
                    success_criteria: vec![],
                    capability_scope: None,
                    subagent: None,
                })
                .unwrap();
            let artifacts = AgentArtifactStore::default();
            artifacts.configure(&root).unwrap();
            let metadata = artifacts
                .store_json(
                    id,
                    "tool-result",
                    "Repository storage guide",
                    &serde_json::json!({"text": include_str!("../../AGENTS.md")}),
                )
                .unwrap();
            assert!(database_path.is_file());
            assert!(root
                .join("agent-runtime/sessions-v5")
                .join(format!("{id}.jsonl"))
                .is_file());
            assert!(root.join("agent-runtime/archives-v5").is_dir());
            assert!(root
                .join("agent-runtime/artifacts-v2")
                .join(id)
                .join(format!("{}.bin", metadata.artifact_id))
                .is_file());
            let reopened = AgentSessionStore::default();
            reopened.configure(root).unwrap();
            assert_eq!(reopened.snapshot(id).unwrap().header.session_id, id);
            assert_eq!(
                artifacts.verify(id, &metadata).unwrap(),
                crate::agent_runtime::AgentArtifactIntegrity::Verified
            );
        }
    }

    #[test]
    fn uses_separate_data_directories_for_development_and_production() {
        let home = Path::new("test-home");

        assert_eq!(
            shellspan_data_dir_for_mode(home, true),
            home.join(".shellspan-dev")
        );
        assert_eq!(
            shellspan_data_dir_for_mode(home, false),
            home.join(".shellspan")
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_uses_the_development_data_directory() {
        assert_eq!(
            shellspan_data_dir(Path::new("test-home")),
            Path::new("test-home").join(".shellspan-dev")
        );
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_uses_the_production_data_directory() {
        assert_eq!(
            shellspan_data_dir(Path::new("test-home")),
            Path::new("test-home").join(".shellspan")
        );
    }

    #[test]
    fn posix_join_appends_child_with_single_separator() {
        assert_eq!(
            posix_join("/srv/files", "report.txt"),
            "/srv/files/report.txt"
        );
        assert_eq!(
            posix_join("/srv/files/", "report.txt"),
            "/srv/files/report.txt"
        );
        assert_eq!(
            posix_join("/srv/files//", "report.txt"),
            "/srv/files/report.txt"
        );
    }

    #[test]
    fn posix_join_strips_leading_separators_from_child() {
        assert_eq!(
            posix_join("/srv/files", "/report.txt"),
            "/srv/files/report.txt"
        );
        assert_eq!(
            posix_join("/srv/files", "//report.txt"),
            "/srv/files/report.txt"
        );
    }

    #[test]
    fn posix_join_handles_root_and_empty_parent() {
        assert_eq!(posix_join("/", "report.txt"), "/report.txt");
        assert_eq!(posix_join("", "report.txt"), "report.txt");
    }

    #[test]
    fn posix_join_returns_parent_for_empty_child() {
        assert_eq!(posix_join("/srv/files", ""), "/srv/files");
        assert_eq!(posix_join("/srv/files", "/"), "/srv/files");
    }

    #[test]
    fn posix_join_never_emits_backslashes() {
        assert!(!posix_join("/srv/files", "report.txt").contains('\\'));
    }

    #[test]
    fn converts_windows_paths_to_portable_slash_format() {
        assert_eq!(
            portable_local_path_string(r"C:\Users\tester"),
            "C:/Users/tester"
        );
        assert_eq!(
            portable_local_path_string(r"\\?\C:\Users\tester"),
            "C:/Users/tester"
        );
        assert_eq!(
            portable_local_path_string(r"\\?\UNC\server\share\folder"),
            "//server/share/folder"
        );
    }

    #[test]
    fn leaves_posix_paths_unchanged() {
        assert_eq!(portable_local_path_string("/Users/tester"), "/Users/tester");
    }
}
