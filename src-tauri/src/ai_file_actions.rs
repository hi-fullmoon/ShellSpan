use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

const CLIPBOARD_TEXT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LocalFileApp {
    VsCode,
    Terminal,
    Iterm,
    Xcode,
    AndroidStudio,
    SystemPicker,
}

#[cfg(target_os = "macos")]
impl LocalFileApp {
    const MAC_APPS: [Self; 5] = [
        Self::VsCode,
        Self::Terminal,
        Self::Iterm,
        Self::Xcode,
        Self::AndroidStudio,
    ];

    fn bundle_id(self) -> Option<&'static str> {
        match self {
            Self::VsCode => Some("com.microsoft.VSCode"),
            Self::Terminal => Some("com.apple.Terminal"),
            Self::Iterm => Some("com.googlecode.iterm2"),
            Self::Xcode => Some("com.apple.dt.Xcode"),
            Self::AndroidStudio => Some("com.google.android.studio"),
            Self::SystemPicker => None,
        }
    }

    fn bundle_path(self) -> Option<PathBuf> {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;

        let id = self.bundle_id()?;
        objc2::rc::autoreleasepool(|_| {
            let bundle = NSWorkspace::sharedWorkspace()
                .URLForApplicationWithBundleIdentifier(&NSString::from_str(id))?;
            bundle.path().map(|path| path.to_string().into())
        })
    }
}

#[tauri::command]
pub(crate) async fn list_local_file_apps() -> Result<Vec<LocalFileApp>, String> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(|| {
        LocalFileApp::MAC_APPS
            .into_iter()
            .filter(|app| app.bundle_path().is_some())
            .collect()
    })
    .await
    .map_err(|error| format!("failed to list file applications: {error}"));

    #[cfg(target_os = "windows")]
    return Ok(vec![LocalFileApp::SystemPicker]);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok(Vec::new())
}

#[tauri::command]
pub(crate) async fn open_local_file_with(
    path: String,
    line: Option<u32>,
    column: Option<u32>,
    app: LocalFileApp,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        let path = canonical_local_path(Path::new(&path))?;
        let id = app.bundle_id().ok_or("invalid application choice")?;
        if let (LocalFileApp::VsCode, Some(line)) = (app, line.filter(|line| *line > 0)) {
            if path.is_file() {
                return open_vs_code_at_line(path, line, column);
            }
        }
        let target =
            if matches!(app, LocalFileApp::Terminal | LocalFileApp::Iterm) && path.is_file() {
                path.parent().ok_or("file has no parent directory")?
            } else {
                &path
            };
        crate::file_actions::open_with_application(target, id).map(|_| ())
    })
    .await
    .map_err(|error| format!("failed to run launch task: {error}"))?;

    #[cfg(not(target_os = "macos"))]
    let _ = (line, column);

    #[cfg(target_os = "windows")]
    if matches!(app, LocalFileApp::SystemPicker) {
        return crate::file_actions::open_local_file_with_application(path, "system-picker".into())
            .await;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (path, app);
    #[cfg(not(target_os = "macos"))]
    Err("invalid application choice".into())
}

#[cfg(target_os = "macos")]
fn open_vs_code_at_line(path: PathBuf, line: u32, column: Option<u32>) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let bundle = LocalFileApp::VsCode
        .bundle_path()
        .ok_or("VS Code is not installed")?;
    let mut location = path.into_os_string();
    location.push(format!(":{line}:{}", column.unwrap_or(1).max(1)));
    let status = Command::new(bundle.join("Contents/Resources/app/bin/code"))
        .arg("--goto")
        .arg(location)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("failed to launch VS Code: {error}"))?;
    if !status.success() {
        return Err(format!("VS Code launcher exited with {status}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn save_local_file_as(path: String, title: String) -> Result<bool, String> {
    let source = path.clone();
    let name = tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&source);
        if !canonical_local_path(source)?.is_file() {
            return Err("source must be a regular file".into());
        }
        source
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .ok_or_else(|| String::from("source file has no name"))
    })
    .await
    .map_err(|error| format!("failed to inspect source: {error}"))??;
    let destination =
        crate::file_actions::pick_preview_save_destination(name, Some(path.clone()), title).await?;
    let Some(destination) = destination else {
        return Ok(false);
    };
    crate::file_actions::save_local_preview_file(path, destination).await?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn read_local_file_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_text(&path, CLIPBOARD_TEXT_LIMIT))
        .await
        .map_err(|error| format!("failed to run file read task: {error}"))?
}

fn canonical_local_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve path: {error}"))?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("failed to inspect path: {error}"))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("path must be a regular file or directory".into());
    }
    Ok(path)
}

fn read_file_text(path: &str, limit: u64) -> Result<String, String> {
    let path = canonical_local_path(Path::new(path))?;
    if !path.is_file() {
        return Err("source must be a regular file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Refuse a substituted symlink or FIFO at the final component.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("failed to open source: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| format!("failed to inspect source: {error}"))?
        .is_file()
    {
        return Err("source must be a regular file".into());
    }
    let mut contents = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut contents)
        .map_err(|error| format!("failed to read source: {error}"))?;
    if contents.len() as u64 > limit {
        return Err("file exceeds the clipboard size limit".into());
    }
    crate::remote_fs::decode_preview_text(&contents, false)
        .ok_or_else(|| "file does not contain supported text".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_complete_text_and_rejects_non_text_or_oversized_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("file with spaces.svg");
        let path_string = path.to_str().unwrap();
        let text = "第一行\r\nsecond line\n";
        fs::write(&path, text).unwrap();
        assert_eq!(
            read_file_text(path_string, text.len() as u64).unwrap(),
            text
        );
        assert!(read_file_text(path_string, text.len() as u64 - 1).is_err());
        fs::write(&path, [0, 0xff, 0, 42]).unwrap();
        assert!(read_file_text(path_string, 1024).is_err());
        assert!(read_file_text(temporary.path().to_str().unwrap(), 1024).is_err());
        assert!(read_file_text("relative.txt", 1024).is_err());
    }

    #[test]
    fn save_as_reuses_the_native_copy_and_preserves_binary_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("original.bin");
        let target = temporary.path().join("renamed copy.bin");
        let bytes = [0x00, 0xff, 0x8a, 0x0a];
        fs::write(&source, bytes).unwrap();
        let destination = crate::file_actions::SaveFileDestination::selected(&target).unwrap();
        tauri::async_runtime::block_on(crate::file_actions::save_local_preview_file(
            source.to_str().unwrap().to_owned(),
            destination,
        ))
        .unwrap();
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_application_discovery_finds_the_installed_terminal() {
        assert!(LocalFileApp::Terminal.bundle_path().unwrap().is_dir());
        let apps = tauri::async_runtime::block_on(list_local_file_apps()).unwrap();
        assert!(apps.iter().any(|app| matches!(app, LocalFileApp::Terminal)));
    }
}
