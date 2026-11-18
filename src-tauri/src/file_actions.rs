use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub(crate) struct FileOpenApplication {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
const APPLICATION_ICON_SIZE: u32 = 32;

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn png_icon_data_url(png: &[u8]) -> String {
    use base64::Engine;

    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveFileDestination {
    pub(crate) path: String,
    replace_existing: bool,
}

impl SaveFileDestination {
    pub(crate) fn selected(path: &Path) -> Result<Self, String> {
        Ok(Self {
            replace_existing: existing_regular_file(path)?,
            path: path
                .to_str()
                .ok_or("save destination is not valid Unicode")?
                .to_owned(),
        })
    }

    pub(crate) fn create_staging_file(&self) -> Result<tempfile::NamedTempFile, String> {
        let path = Path::new(&self.path);
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("save destination must be an absolute file path".into());
        }
        let directory = path.parent().ok_or("save destination has no parent")?;
        tempfile::Builder::new()
            .prefix(".shellspan-save-")
            .tempfile_in(directory)
            .map_err(|error| format!("failed to prepare save destination: {error}"))
    }

    pub(crate) fn persist(&self, staging: tempfile::NamedTempFile) -> Result<(), String> {
        let path = Path::new(&self.path);
        let replace = self.replace_existing && existing_regular_file(path)?;
        let result = if replace {
            staging.persist(path)
        } else {
            staging.persist_noclobber(path)
        };
        result
            .map(|_| ())
            .map_err(|error| format!("failed to save file: {}", error.error))
    }
}

fn existing_regular_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err("save destination is not a regular file".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("failed to inspect save destination: {error}")),
    }
}

#[tauri::command]
pub(crate) async fn pick_preview_save_destination(
    name: String,
    local_path: Option<String>,
    title: String,
) -> Result<Option<SaveFileDestination>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(title);
        if Path::new(&name)
            .file_name()
            .is_some_and(|part| part == name.as_str())
        {
            dialog = dialog.set_file_name(name);
        }
        if let Some(directory) = local_path
            .as_deref()
            .and_then(|path| Path::new(path).parent())
        {
            dialog = dialog.set_directory(directory);
        }
        let Some(path) = dialog.save_file() else {
            return Ok(None);
        };
        SaveFileDestination::selected(&path).map(Some)
    })
    .await
    .map_err(|error| format!("failed to run save dialog: {error}"))?
}

fn resolve_local_file(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("file path must be absolute".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve file path: {error}"))?;
    if !resolved.is_file() {
        return Err("path is not a regular file".into());
    }
    Ok(resolved)
}

fn save_local_file_blocking(path: &Path, destination: &SaveFileDestination) -> Result<(), String> {
    let path = resolve_local_file(path)?;
    if Path::new(&destination.path)
        .canonicalize()
        .is_ok_and(|target| target == path)
    {
        return Ok(());
    }
    let mut source =
        fs::File::open(path).map_err(|error| format!("failed to open source file: {error}"))?;
    let mut staging = destination.create_staging_file()?;
    io::copy(&mut source, &mut staging).map_err(|error| format!("failed to copy file: {error}"))?;
    destination.persist(staging)
}

#[tauri::command]
pub(crate) async fn save_local_preview_file(
    path: String,
    destination: SaveFileDestination,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_local_file_blocking(Path::new(&path), &destination)
    })
    .await
    .map_err(|error| format!("failed to run save task: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_file_open_default_icon(
    app: tauri::AppHandle,
    name: String,
    local_path: Option<String>,
) -> Result<Option<String>, String> {
    let icon = tauri::async_runtime::spawn_blocking(move || {
        let local_path = local_path
            .as_deref()
            .map(Path::new)
            .map(resolve_local_file)
            .transpose()
            .ok()?;
        default_application_icon(&name, local_path.as_deref())
    })
    .await
    .map_err(|error| format!("failed to query default application icon: {error}"))?;

    #[cfg(target_os = "linux")]
    let icon = load_linux_application_icons(&app, vec![icon])
        .await
        .pop()
        .flatten();
    #[cfg(not(target_os = "linux"))]
    let _ = app;

    Ok(icon)
}

#[tauri::command]
pub(crate) async fn list_file_open_applications(
    app: tauri::AppHandle,
    name: String,
    local_path: Option<String>,
) -> Result<Vec<FileOpenApplication>, String> {
    let applications = tauri::async_runtime::spawn_blocking(move || {
        let local_path = local_path
            .as_deref()
            .map(Path::new)
            .map(resolve_local_file)
            .transpose()?;
        Ok::<_, String>(list_applications(&name, local_path.as_deref()))
    })
    .await
    .map_err(|error| format!("failed to query file applications: {error}"))??;

    #[cfg(target_os = "linux")]
    let applications = {
        let (mut apps, icon_names): (Vec<_>, Vec<_>) = applications.into_iter().unzip();
        let icons = load_linux_application_icons(&app, icon_names).await;
        for (application, icon) in apps.iter_mut().zip(icons) {
            application.icon = icon;
        }
        apps
    };
    #[cfg(not(target_os = "linux"))]
    let _ = app;

    Ok(applications)
}

#[tauri::command]
pub(crate) async fn open_local_file_with_application(
    path: String,
    application_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_local_file(Path::new(&path))?;
        open_with_application(&path, &application_id).map(|_| ())
    })
    .await
    .map_err(|error| format!("failed to run open task: {error}"))?
}

#[cfg(target_os = "macos")]
fn macos_file_type(
    name: &str,
) -> Option<objc2::rc::Retained<objc2_uniform_type_identifiers::UTType>> {
    use objc2_foundation::NSString;
    use objc2_uniform_type_identifiers::UTType;

    let extension = Path::new(name).extension()?.to_str()?;
    UTType::typeWithFilenameExtension(&NSString::from_str(extension))
}

#[cfg(target_os = "macos")]
fn default_application_icon(name: &str, local_path: Option<&Path>) -> Option<String> {
    use objc2::runtime::NSObjectProtocol;
    use objc2::sel;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    objc2::rc::autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let app_url = if let Some(path) = local_path {
            let url = NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(&path.to_string_lossy()),
                false,
            );
            workspace.URLForApplicationToOpenURL(&url)
        } else {
            if !workspace.respondsToSelector(sel!(URLForApplicationToOpenContentType:)) {
                return None;
            }
            let file_type = macos_file_type(name)?;
            workspace.URLForApplicationToOpenContentType(&file_type)
        }?;
        macos_application_icon(&workspace, app_url.path().as_deref()?)
    })
}

#[cfg(target_os = "macos")]
fn list_applications(name: &str, local_path: Option<&Path>) -> Vec<FileOpenApplication> {
    use objc2::runtime::NSObjectProtocol;
    use objc2::sel;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSFileManager, NSString, NSURL};

    objc2::rc::autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        if !workspace.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
            return Vec::new();
        }
        let applications = if let Some(path) = local_path {
            let url = NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(&path.to_string_lossy()),
                false,
            );
            workspace.URLsForApplicationsToOpenURL(&url)
        } else {
            let Some(file_type) = macos_file_type(name) else {
                return Vec::new();
            };
            workspace.URLsForApplicationsToOpenContentType(&file_type)
        };
        let manager = NSFileManager::defaultManager();
        let mut ids = std::collections::HashSet::new();
        applications
            .iter()
            .filter_map(|url| {
                let id = NSBundle::bundleWithURL(&url)?
                    .bundleIdentifier()?
                    .to_string();
                let path = url.path()?;
                ids.insert(id.clone()).then(|| FileOpenApplication {
                    id,
                    name: manager.displayNameAtPath(&path).to_string(),
                    icon: macos_application_icon(&workspace, &path),
                })
            })
            .collect()
    })
}

#[cfg(target_os = "macos")]
fn macos_application_icon(
    workspace: &objc2_app_kit::NSWorkspace,
    path: &objc2_foundation::NSString,
) -> Option<String> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize};

    let size = f64::from(APPLICATION_ICON_SIZE);
    let mut bounds = NSRect::new(NSPoint::ZERO, NSSize::new(size, size));
    let icon = workspace.iconForFile(path);
    // The destination rectangle is writable and no extra drawing hints are needed.
    let image = unsafe { icon.CGImageForProposedRect_context_hints(&mut bounds, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
    // The empty properties dictionary uses AppKit's default PNG encoding.
    let data = unsafe {
        bitmap.representationUsingType_properties(
            NSBitmapImageFileType::PNG,
            &NSDictionary::dictionary(),
        )
    }?;
    let png = data.to_vec();
    if bitmap.pixelsWide() <= APPLICATION_ICON_SIZE as isize
        && bitmap.pixelsHigh() <= APPLICATION_ICON_SIZE as isize
    {
        return Some(png_icon_data_url(&png));
    }

    let icon = image::load_from_memory_with_format(&png, image::ImageFormat::Png).ok()?;
    let mut scaled = io::Cursor::new(Vec::new());
    icon.thumbnail(APPLICATION_ICON_SIZE, APPLICATION_ICON_SIZE)
        .write_to(&mut scaled, image::ImageFormat::Png)
        .ok()?;
    Some(png_icon_data_url(&scaled.into_inner()))
}

#[cfg(target_os = "macos")]
pub(crate) fn open_with_application(path: &Path, application_id: &str) -> Result<bool, String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    let application_path = objc2::rc::autoreleasepool(|_| {
        NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(application_id))
            .and_then(|url| url.path())
            .map(|path| path.to_string())
    })
    .ok_or("the selected application is no longer installed")?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(application_path)
        .arg(path)
        .status()
        .map_err(|error| format!("failed to open file with selected application: {error}"))?;
    if !status.success() {
        return Err(format!(
            "failed to open file with selected application: {status}"
        ));
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
fn applications_for_path(path: &Path) -> Vec<gio::AppInfo> {
    let (content_type, _) = gio::content_type_guess(Some(path), None);
    gio::AppInfo::all_for_type(&content_type)
}

#[cfg(target_os = "linux")]
fn default_application_icon(name: &str, local_path: Option<&Path>) -> Option<String> {
    use gio::prelude::*;

    let content_type = local_path
        .and_then(|path| {
            gio::File::for_path(path)
                .query_info(
                    gio::FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
                    gio::FileQueryInfoFlags::NONE,
                    gio::Cancellable::NONE,
                )
                .ok()?
                .content_type()
        })
        .unwrap_or_else(|| gio::content_type_guess(Some(Path::new(name)), None).0);
    let app = gio::AppInfo::default_for_type(&content_type, false)?;
    Some(app.icon()?.to_string()?.to_string())
}

#[cfg(target_os = "linux")]
fn list_applications(
    name: &str,
    local_path: Option<&Path>,
) -> Vec<(FileOpenApplication, Option<String>)> {
    use gio::prelude::*;

    applications_for_path(local_path.unwrap_or_else(|| Path::new(name)))
        .into_iter()
        .filter(|application| application.should_show())
        .filter_map(|application| {
            let app = FileOpenApplication {
                id: application.id()?.to_string(),
                name: application.display_name().to_string(),
                icon: None,
            };
            let icon = application
                .icon()
                .and_then(|icon| icon.to_string())
                .map(|icon| icon.to_string());
            Some((app, icon))
        })
        .collect()
}

#[cfg(target_os = "linux")]
async fn load_linux_application_icons(
    app: &tauri::AppHandle,
    icon_names: Vec<Option<String>>,
) -> Vec<Option<String>> {
    use gtk::prelude::*;

    if icon_names.iter().all(Option::is_none) {
        return Vec::new();
    }
    let size = APPLICATION_ICON_SIZE as i32;
    let (send_paths, receive_paths) = tokio::sync::oneshot::channel();
    let lookup = app.run_on_main_thread(move || {
        if !gtk::is_initialized_main_thread() {
            return;
        }
        let Some(theme) = gtk::IconTheme::default() else {
            return;
        };
        let paths: Vec<_> = icon_names
            .into_iter()
            .map(|name| {
                let icon = gio::Icon::for_string(&name?).ok()?;
                theme
                    .lookup_by_gicon(&icon, size, gtk::IconLookupFlags::empty())?
                    .filename()
            })
            .collect();
        let _ = send_paths.send(paths);
    });
    if lookup.is_err() {
        return Vec::new();
    }
    let Ok(paths) = receive_paths.await else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let path = path.filter(|path| path.is_file())?;
                let icon = gdk_pixbuf::Pixbuf::from_file_at_scale(path, size, size, true).ok()?;
                let png = icon.save_to_bufferv("png", &[]).ok()?;
                Some(png_icon_data_url(&png))
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
}

#[cfg(target_os = "linux")]
pub(crate) fn open_with_application(path: &Path, application_id: &str) -> Result<bool, String> {
    use gio::prelude::*;

    let application = gio::AppInfo::all()
        .into_iter()
        .find(|application| {
            application.should_show() && application.id().as_deref() == Some(application_id)
        })
        .ok_or("the selected application is no longer installed")?;
    application
        .launch(&[gio::File::for_path(path)], gio::AppLaunchContext::NONE)
        .map_err(|error| format!("failed to open file with selected application: {error}"))?;
    Ok(true)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn list_applications(_name: &str, _local_path: Option<&Path>) -> Vec<FileOpenApplication> {
    Vec::new()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn default_application_icon(_name: &str, _local_path: Option<&Path>) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn default_application_icon(name: &str, local_path: Option<&Path>) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{S_FALSE, S_OK};
    use windows_sys::Win32::UI::Shell::{
        AssocQueryStringW, ASSOCF_NOTRUNCATE, ASSOCF_REMAPRUNDLL, ASSOCSTR_EXECUTABLE,
    };

    let extension = local_path.unwrap_or_else(|| Path::new(name)).extension()?;
    let mut association: Vec<u16> = std::iter::once(u16::from(b'.'))
        .chain(extension.encode_wide())
        .collect();
    if association.contains(&0) {
        return None;
    }
    association.push(0);
    let verb = windows_sys::w!("open");
    let flags = ASSOCF_NOTRUNCATE | ASSOCF_REMAPRUNDLL;
    let mut length = 0;
    // A null output buffer asks the Shell for the required UTF-16 length.
    let status = unsafe {
        AssocQueryStringW(
            flags,
            ASSOCSTR_EXECUTABLE,
            association.as_ptr(),
            verb,
            null_mut(),
            &mut length,
        )
    };
    if status != S_FALSE || !(2..=32768).contains(&length) {
        return None;
    }
    let mut executable = vec![0; length as usize];
    // The output buffer has exactly the capacity passed to the Shell.
    let status = unsafe {
        AssocQueryStringW(
            flags,
            ASSOCSTR_EXECUTABLE,
            association.as_ptr(),
            verb,
            executable.as_mut_ptr(),
            &mut length,
        )
    };
    if status != S_OK {
        return None;
    }
    let executable = PathBuf::from(OsString::from_wide(
        &executable[..executable.iter().position(|&unit| unit == 0)?],
    ));
    if !executable.is_absolute() || !executable.is_file() {
        return None;
    }

    let icon = file_icon_provider::get_file_icon(executable, APPLICATION_ICON_SIZE as u16).ok()?;
    let bitmap = image::RgbaImage::from_raw(icon.width, icon.height, icon.pixels)?;
    let mut png = io::Cursor::new(Vec::new());
    bitmap.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png_icon_data_url(&png.into_inner()))
}

#[cfg(target_os = "windows")]
pub(crate) fn open_with_application(path: &Path, application_id: &str) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OPENASINFO};

    if application_id != "system-picker" {
        return Err("invalid Windows application choice".into());
    }
    let path = crate::path_utils::portable_local_path(path).replace('/', "\\");
    let path = std::ffi::OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let initialized = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
    if initialized < 0 {
        return Err(format!(
            "failed to initialize the application picker: {initialized:#x}"
        ));
    }
    let result = unsafe {
        let options = OPENASINFO {
            pcszFile: path.as_ptr(),
            pcszClass: std::ptr::null(),
            oaifInFlags: OAIF_EXEC,
        };
        let result = SHOpenWithDialog(std::ptr::null_mut(), &options);
        CoUninitialize();
        result
    };
    if result == 0x800704c7_u32 as i32 {
        return Ok(false);
    }
    if result < 0 {
        return Err(format!(
            "failed to open file with selected application: {result:#x}"
        ));
    }
    Ok(true)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn open_with_application(_path: &Path, _application_id: &str) -> Result<bool, String> {
    Err("application selection is unavailable on this system".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_local_preview_copies_original_bytes_to_the_chosen_name() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../LICENSE");
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ShellSpan license.txt");
        fs::write(&path, include_bytes!("../../public/shellspan-icon.svg")).unwrap();
        let destination = SaveFileDestination::selected(&path).unwrap();

        save_local_file_blocking(&source, &destination).unwrap();

        assert_eq!(fs::read(&path).unwrap(), fs::read(source).unwrap());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn save_local_preview_preserves_a_file_created_after_destination_selection() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../LICENSE");
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ShellSpan license.txt");
        let destination = SaveFileDestination::selected(&path).unwrap();
        let existing = include_bytes!("../../public/shellspan-icon.svg");
        fs::write(&path, existing).unwrap();

        assert!(save_local_file_blocking(&source, &destination).is_err());
        assert_eq!(fs::read(&path).unwrap(), existing);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn discovers_installed_macos_text_applications_for_local_and_remote_names() {
        use base64::Engine;

        if !Path::new("/System/Applications/TextEdit.app").exists() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join("ShellSpan license.txt");
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../LICENSE"),
            &local,
        )
        .unwrap();

        for location in [Some(local.as_path()), None] {
            let applications = list_applications("ShellSpan license.txt", location);
            let text_edit = applications
                .iter()
                .find(|app| app.id == "com.apple.TextEdit")
                .expect("TextEdit should be available for text previews");
            assert!(!text_edit.name.is_empty());
            let encoded = text_edit
                .icon
                .as_deref()
                .and_then(|icon| icon.strip_prefix("data:image/png;base64,"))
                .expect("TextEdit should provide a PNG application icon");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap();
            let icon =
                image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
            assert!((1..=APPLICATION_ICON_SIZE).contains(&icon.width()));
            assert!((1..=APPLICATION_ICON_SIZE).contains(&icon.height()));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn looks_up_default_application_icon_for_local_path_and_remote_name() {
        use base64::Engine;

        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join("ShellSpan license.txt");
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../LICENSE"),
            &local,
        )
        .unwrap();
        for location in [Some(local.as_path()), None] {
            let icon = default_application_icon("ShellSpan license.txt", location)
                .expect("the system default text editor should have an icon");
            let encoded = icon.strip_prefix("data:image/png;base64,").unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap();
            let image =
                image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
            assert!((1..=APPLICATION_ICON_SIZE).contains(&image.width()));
            assert!((1..=APPLICATION_ICON_SIZE).contains(&image.height()));
        }
    }
}
