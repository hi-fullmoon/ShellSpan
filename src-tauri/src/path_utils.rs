use std::path::{Path, PathBuf};

const SHELLSPAN_DATA_DIRECTORY: &str = ".shellspan";
const SHELLSPAN_DEV_DATA_DIRECTORY: &str = ".shellspan-dev";

pub(crate) fn shellspan_data_dir(home_dir: &Path) -> PathBuf {
    shellspan_data_dir_for_mode(home_dir, cfg!(debug_assertions))
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
