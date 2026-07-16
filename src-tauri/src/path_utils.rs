use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::*;

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
