//! Local fixed tool admission only. No PATH lookup or caller-provided command.
use crate::appcontainer_probe::{win, Handle};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
pub const FIXED_BUILD_SOURCE: &str = "public static class FixedBuild { public static string Render() { return \"fixed PowerShell artifact\"; } }\n";
pub(crate) fn create_fixed_build_source(root: &Path) -> Result<ToolImageLease, String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("fixed-build.cs"))
        .map_err(|e| e.to_string())?;
    file.write_all(FIXED_BUILD_SOURCE.as_bytes())
        .map_err(|e| e.to_string())?;
    drop(file);
    open_fixed_build_source(root)
}
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
pub fn verified_git_version_output(stdout: &str, stderr: &str) -> bool {
    let version = stdout
        .strip_prefix("git version ")
        .and_then(|text| text.strip_suffix('\n'))
        .map(|text| text.strip_suffix('\r').unwrap_or(text));
    stderr.is_empty() && version == Some(FIXED_GIT_VERSION)
}
pub fn verify_git_init(root: &Path) -> Result<(), String> {
    if !root.is_absolute()
        || root
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
            .and_then(|name| uuid::Uuid::parse_str(name).ok())
            .is_none_or(|id| id.is_nil())
    {
        return Err("Git repository check requires owned UUID fixture".into());
    }
    let _root = crate::appcontainer_probe::verify_retirement_object(root)?;
    let output = root.join("output");
    let _output = crate::appcontainer_probe::verify_retirement_object(&output)?;
    for directory in [
        "objects",
        "objects/info",
        "objects/pack",
        "refs",
        "refs/heads",
        "refs/tags",
    ] {
        let _held = crate::appcontainer_probe::verify_retirement_object(&output.join(directory))?;
    }
    let head = ToolImageLease::open(&output.join("HEAD"))?;
    if head.read_bytes()? != b"ref: refs/heads/main\n" {
        return Err("fixed Git HEAD differs".into());
    }
    let config = ToolImageLease::open(&output.join("config"))?;
    if config.identity.bytes > 1024 {
        return Err("fixed Git config exceeds budget".into());
    }
    let config = String::from_utf8(config.read_bytes()?).map_err(|_| "fixed Git config invalid")?;
    if !config.lines().any(|line| line.trim() == "bare = true")
        || config.contains("[remote ")
        || output.join("hooks").exists()
    {
        return Err("fixed bare Git repository configuration differs".into());
    }
    Ok(())
}
/// Version covered by the owned runtime admission evidence, not a compatibility range.
pub const FIXED_GIT_VERSION: &str = "2.55.0.windows.3";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixedTool {
    PowerShell,
    PowerShell7,
    PowerShell7OwnedEntry,
    PowerShell7Runtime,
    PowerShell7RuntimeArtifact,
    PowerShell7RuntimeBuild,
    PowerShellEtwProbe,
    Git,
    GitRuntime,
    GitBundle,
    GitBundleInit,
    GitDependencyProbe,
    GitPrefixProbe,
    CrossSlotRegistryProbe,
    Node,
}
impl FixedTool {
    pub fn from_source_cli(value: &str) -> Option<Self> {
        match value {
            "--run-source-powershell-control" => Some(Self::PowerShell),
            "--run-source-powershell7-control" => Some(Self::PowerShell7),
            "--run-source-powershell7-build-control" => Some(Self::PowerShell7RuntimeBuild),
            "--run-source-powershell-etw-probe" => Some(Self::PowerShellEtwProbe),
            "--run-source-git-control" => Some(Self::Git),
            "--run-source-git-runtime-control" => Some(Self::GitRuntime),
            "--run-source-git-init-control" => Some(Self::GitBundleInit),
            "--run-source-git-dependency-probe" => Some(Self::GitDependencyProbe),
            "--run-source-git-prefix-probe" => Some(Self::GitPrefixProbe),
            "--run-source-node-control" => Some(Self::Node),
            _ => None,
        }
    }
    pub fn from_cli(value: &str) -> Option<Self> {
        match value {
            "--run-lpac-powershell-admission" => Some(Self::PowerShell),
            "--run-lpac-powershell7-admission" => Some(Self::PowerShell7),
            "--run-lpac-powershell7-owned-entry" => Some(Self::PowerShell7OwnedEntry),
            "--run-lpac-powershell7-runtime" => Some(Self::PowerShell7Runtime),
            "--run-lpac-powershell7-build" => Some(Self::PowerShell7RuntimeBuild),
            "--run-lpac-powershell-etw-probe" => Some(Self::PowerShellEtwProbe),
            "--run-lpac-git-admission" => Some(Self::Git),
            "--run-lpac-git-runtime-admission" => Some(Self::GitRuntime),
            "--run-lpac-git-bundle-admission" => Some(Self::GitBundle),
            "--run-lpac-git-init" => Some(Self::GitBundleInit),
            "--run-lpac-git-dependency-probe" => Some(Self::GitDependencyProbe),
            "--run-lpac-git-prefix-probe" => Some(Self::GitPrefixProbe),
            "--run-lpac-node-admission" => Some(Self::Node),
            _ => None,
        }
    }
    pub fn command(self) -> &'static str {
        match self {
            Self::PowerShell => {
                "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"exit 73\""
            }
            Self::PowerShell7RuntimeArtifact => "pwsh.exe -NoLogo -NoProfile -NonInteractive -Command \"$ErrorActionPreference='Stop';$p=[IO.Path]::Combine($env:SSPA_FIXTURE,'output','powershell-fixed-artifact.txt');[IO.File]::WriteAllText($p,'fixed PowerShell artifact');if([IO.File]::ReadAllText($p) -cne 'fixed PowerShell artifact'){exit 74};exit 73\"",
            Self::PowerShell7RuntimeBuild => "pwsh.exe -NoLogo -NoProfile -NonInteractive -Command \"$ErrorActionPreference='Stop';Import-Module ([IO.Path]::Combine($PSHOME,'Microsoft.PowerShell.Commands.Utility.dll'));$dll=[IO.Path]::Combine($env:SSPA_FIXTURE,'output','powershell-fixed-build.dll');$src=[IO.Path]::Combine($env:SSPA_FIXTURE,'fixed-build.cs');try{[IO.File]::WriteAllText($src,'tampered');exit 74}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$code=$e.HResult -band 65535;if($code -notin @(5,32)){throw}};Add-Type -Path $src -OutputAssembly $dll;$d=[IO.File]::ReadAllBytes($dll);$sha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($d));$a=[Reflection.Assembly]::Load($d);$v=$a.GetType('FixedBuild').GetMethod('Render').Invoke($null,@());$p=[IO.Path]::Combine($env:SSPA_FIXTURE,'output','powershell-fixed-artifact.txt');[IO.File]::WriteAllText($p,$v);[IO.File]::WriteAllText([IO.Path]::Combine($env:SSPA_FIXTURE,'output','powershell-fixed-build.sha256'),$sha);if([IO.File]::ReadAllText($p) -cne 'fixed PowerShell artifact'){exit 74};exit 73\"",
            Self::PowerShellEtwProbe => "powershell-etw-probe.exe",
            Self::PowerShell7 | Self::PowerShell7OwnedEntry | Self::PowerShell7Runtime => {
                "pwsh.exe -NoLogo -NoProfile -NonInteractive -Command \"exit 73\""
            }
            Self::Git | Self::GitRuntime | Self::GitBundle => "git.exe --version",
            Self::GitBundleInit => "git.exe init --bare --template= --initial-branch=main",
            Self::GitDependencyProbe => "probe.exe --owned-fixed-git-dependency-probe",
            Self::GitPrefixProbe => "probe.exe --owned-fixed-git-prefix-probe",
            Self::CrossSlotRegistryProbe => "probe.exe --owned-fixed-cross-slot-registry-access-probe",
            Self::Node => "node.exe -e \"const p=require('node:path');const root=process.env.SSPA_FIXTURE;process.exit(root&&p.resolve(process.cwd()).toLowerCase()===p.resolve(root,'output').toLowerCase()?73:74)\"",
        }
    }
    pub fn expected_exit(self) -> u32 {
        if matches!(
            self,
            Self::Git | Self::GitRuntime | Self::GitBundle | Self::GitBundleInit
        ) {
            0
        } else {
            73
        }
    }
    pub fn decode_output(self, data: &[u8]) -> Result<String, String> {
        if matches!(self, Self::PowerShell) {
            if !data.len().is_multiple_of(2) {
                return Err("fixed PowerShell diagnostic has incomplete UTF-16 code unit".into());
            }
            let units: Vec<_> = data
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(units.strip_prefix(&[0xfeff]).unwrap_or(&units))
                .map_err(|_| "fixed PowerShell diagnostic has invalid UTF-16".into())
        } else {
            String::from_utf8(data.to_vec())
                .map_err(|_| "fixed tool diagnostic has invalid UTF-8".into())
        }
    }
    pub fn image(self) -> Result<PathBuf, String> {
        Ok(match self {
            Self::PowerShell => {
                let mut system = vec![0u16; 32768];
                let length =
                    unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) }
                        as usize;
                if length == 0 || length >= system.len() {
                    return Err("fixed tool System32 query failed".into());
                }
                PathBuf::from(String::from_utf16(&system[..length]).map_err(|e| e.to_string())?)
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            }
            Self::Git => PathBuf::from(r"D:\Programs\Git\cmd\git.exe"),
            Self::PowerShell7
            | Self::PowerShell7OwnedEntry
            | Self::PowerShell7Runtime
            | Self::PowerShell7RuntimeArtifact
            | Self::PowerShell7RuntimeBuild => PathBuf::from(r"D:\Programs\PowerShell\7\pwsh.exe"),
            Self::GitRuntime | Self::GitBundle | Self::GitBundleInit => {
                PathBuf::from(r"D:\Programs\Git\mingw64\bin\git.exe")
            }
            Self::GitDependencyProbe | Self::GitPrefixProbe | Self::CrossSlotRegistryProbe => {
                std::env::current_exe().map_err(|e| e.to_string())?
            }
            Self::PowerShellEtwProbe => std::env::current_exe()
                .map_err(|e| e.to_string())?
                .with_file_name("powershell-etw-probe.exe"),
            Self::Node => PathBuf::from(r"D:\Programs\nodejs\node.exe"),
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolImageIdentity {
    pub path: PathBuf,
    pub volume: u32,
    pub file_index: u64,
    pub bytes: u64,
}
pub struct ToolImageLease {
    _file: Handle,
    _owned_root: Option<Handle>,
    _owned_parent: Option<Handle>,
    pub identity: ToolImageIdentity,
}
pub struct ToolStdio {
    files: [Handle; 3],
    pub inherited: [HANDLE; 3],
}
impl ToolStdio {
    pub fn prepare(root: &Path) -> Result<Self, String> {
        let id = root
            .file_name()
            .and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("ShellSpan-AC-"))
            .and_then(|v| uuid::Uuid::parse_str(v).ok());
        if !root.is_absolute() || id.is_none_or(|id| id.is_nil()) {
            return Err("stdio requires fixed owned fixture".into());
        }
        let attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>()
                as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let open = |path: &Path, access, disposition| -> Result<Handle, String> {
            let wide: Vec<u16> = path
                .to_str()
                .ok_or("invalid stdio path")?
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let raw = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    access,
                    FILE_SHARE_READ,
                    &attributes,
                    disposition,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            };
            if raw == INVALID_HANDLE_VALUE {
                return Err(format!("fixed stdio handle: Win32 {}", unsafe {
                    GetLastError()
                }));
            }
            Ok(Handle(raw))
        };
        let files = [
            open(Path::new("NUL"), GENERIC_READ, OPEN_EXISTING)?,
            open(
                &root.join("output/tool-stdout.txt"),
                GENERIC_READ | GENERIC_WRITE,
                CREATE_NEW,
            )?,
            open(
                &root.join("output/tool-stderr.txt"),
                GENERIC_READ | GENERIC_WRITE,
                CREATE_NEW,
            )?,
        ];
        let inherited = [files[0].0, files[1].0, files[2].0];
        Ok(Self { files, inherited })
    }
    /// Caller must first stop the complete owned Job. Reads the original handles.
    pub fn read_after_stop(&self, tool: FixedTool) -> Result<[String; 2], String> {
        let read = |handle| -> Result<String, String> {
            let mut size = 0i64;
            win(
                unsafe { GetFileSizeEx(handle, &mut size) },
                "bounded tool stdio size",
            )?;
            if !(0..=16384).contains(&size) {
                return Err("tool stdio exceeds 16 KiB budget".into());
            }
            win(
                unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) },
                "rewind fixed tool stdio",
            )?;
            let mut data = vec![0u8; size as usize];
            let mut read = 0;
            if size != 0 {
                win(
                    unsafe {
                        ReadFile(
                            handle,
                            data.as_mut_ptr(),
                            data.len() as u32,
                            &mut read,
                            null_mut(),
                        )
                    },
                    "read fixed tool stdio",
                )?;
            }
            if read as i64 != size {
                return Err("tool stdio changed during stopped-tree read".into());
            }
            tool.decode_output(&data)
        };
        Ok([read(self.files[1].0)?, read(self.files[2].0)?])
    }
}
impl ToolImageLease {
    /// Only self-created immutable copies may receive this diagnostic grant.
    pub fn grant_owned_execution(&self, user: &str, package: &str) -> Result<(), String> {
        use windows_sys::Win32::Security::Authorization::*;
        use windows_sys::Win32::Security::*;
        if self._owned_root.is_none() || !package.starts_with("S-1-15-2-") {
            return Err("execution grant requires a self-created copy and package SID".into());
        }
        for text in [user, package] {
            if text.len() > 184
                || !text.starts_with("S-1-")
                || !text[2..].bytes().all(|v| v.is_ascii_digit() || v == b'-')
            {
                return Err("copy grant SID syntax rejected".into());
            }
            let wide: Vec<_> = text.encode_utf16().chain(Some(0)).collect();
            let mut sid = null_mut();
            win(
                unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) },
                "validate copy grant SID",
            )?;
            let valid = unsafe { IsValidSid(sid) } != 0;
            unsafe {
                LocalFree(sid);
            }
            if !valid {
                return Err("invalid copy grant SID".into());
            }
        }
        let target = crate::appcontainer_probe::verify_retirement_object(&self.identity.path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(target.0, &mut info) },
            "grant copy identity",
        )?;
        if info.dwVolumeSerialNumber != self.identity.volume
            || ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64
                != self.identity.file_index
        {
            return Err("copy identity changed before grant".into());
        }
        let text: Vec<_> = format!("D:P(A;;FA;;;SY)(A;;FA;;;{user})(A;;FRFX;;;{package})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = null_mut();
        win(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            "owned execution descriptor",
        )?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        let result = win(
            unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            },
            "owned execution DACL",
        )
        .and_then(|_| {
            if present == 0 || dacl.is_null() {
                return Err("owned execution DACL missing".into());
            }
            let code = unsafe {
                SetSecurityInfo(
                    target.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null(),
                )
            };
            if code == 0 {
                Ok(())
            } else {
                Err(format!("owned execution grant: Win32 {code}"))
            }
        });
        unsafe {
            LocalFree(descriptor);
        }
        result
    }
    pub fn static_imports(&self) -> Result<Vec<String>, String> {
        crate::pe_imports::static_imports(&self.read_bytes()?)
    }
    pub(crate) fn read_bytes(&self) -> Result<Vec<u8>, String> {
        win(
            unsafe { SetFilePointerEx(self._file.0, 0, null_mut(), FILE_BEGIN) },
            "rewind leased PE image",
        )?;
        let mut data = vec![0u8; self.identity.bytes as usize];
        let mut offset = 0;
        while offset < data.len() {
            let count = (data.len() - offset).min(1024 * 1024);
            let mut read = 0;
            win(
                unsafe {
                    ReadFile(
                        self._file.0,
                        data[offset..].as_mut_ptr(),
                        count as u32,
                        &mut read,
                        null_mut(),
                    )
                },
                "read bounded leased PE image",
            )?;
            if read == 0 {
                return Err("leased PE image ended early".into());
            }
            offset += read as usize;
        }
        Ok(data)
    }
    /// Diagnostic-only copy into a fresh fixture. Keeps both image leases alive;
    /// callers must separately authorize package execution on the new object.
    pub fn copy_new_owned(&self, root: &Path, name: &str) -> Result<Self, String> {
        use std::io::Write;
        use std::os::windows::io::AsRawHandle;
        let parent = if root.file_name().is_some_and(|name| name == "ref") {
            Some(
                root.parent()
                    .ok_or("reference destination parent missing")?,
            )
        } else {
            None
        };
        let id = parent
            .unwrap_or(root)
            .file_name()
            .and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("ShellSpan-AC-"))
            .and_then(|v| uuid::Uuid::parse_str(v).ok());
        if !root.is_absolute()
            || id.is_none_or(|id| id.is_nil())
            || (parent.is_some() && !crate::pe_imports::valid_dll_basename(name))
            || !(matches!(
                name,
                "git.exe"
                    | "pwsh.exe"
                    | "pwsh.deps.json"
                    | "pwsh.runtimeconfig.json"
                    | "powershell-etw-probe.exe"
            ) || crate::pe_imports::valid_dll_basename(name))
        {
            return Err("copy requires an owned UUID fixture and fixed image basename".into());
        }
        let root_lease = crate::appcontainer_probe::verify_retirement_object(root)?;
        let parent_lease = parent
            .map(crate::appcontainer_probe::verify_retirement_object)
            .transpose()?;
        let mut root_info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(root_lease.0, &mut root_info) },
            "copy root identity",
        )?;
        if root_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err("copy root is not a directory".into());
        }
        let data = self.read_bytes()?;
        let path = root.join(name);
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("create owned image: {e}"))?;
        writer
            .write_all(&data)
            .map_err(|e| format!("write owned image: {e}"))?;
        writer
            .sync_all()
            .map_err(|e| format!("flush owned image: {e}"))?;
        let mut written = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(writer.as_raw_handle(), &mut written) },
            "written image identity",
        )?;
        drop(writer);
        let mut copied = Self::open(&path)?;
        let written_index = ((written.nFileIndexHigh as u64) << 32) | written.nFileIndexLow as u64;
        if written.nNumberOfLinks != 1
            || copied.identity.volume != written.dwVolumeSerialNumber
            || copied.identity.file_index != written_index
            || copied.identity.bytes != self.identity.bytes
            || copied.read_bytes()? != data
        {
            return Err("owned image changed between creation and immutable lease".into());
        }
        copied._owned_root = Some(root_lease);
        copied._owned_parent = parent_lease;
        Ok(copied)
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("fixed tool requires absolute image".into());
        }
        let path_wide: Vec<u16> = path
            .to_str()
            .ok_or("invalid fixed image path")?
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let file = Handle(unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        });
        if file.0 == INVALID_HANDLE_VALUE {
            return Err(format!("fixed tool image lease: Win32 {}", unsafe {
                GetLastError()
            }));
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(file.0, &mut info) },
            "fixed tool image identity",
        )?;
        let bytes = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
        if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
            || bytes == 0
            || bytes > 128 * 1024 * 1024
        {
            return Err("fixed tool image type or byte budget invalid".into());
        }
        Ok(Self {
            _file: file,
            _owned_root: None,
            _owned_parent: None,
            identity: ToolImageIdentity {
                path: path.to_path_buf(),
                volume: info.dwVolumeSerialNumber,
                file_index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
                bytes,
            },
        })
    }
}
pub fn verify_powershell_artifact(root: &Path) -> Result<ToolImageIdentity, String> {
    let owned = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .is_some_and(|id| !id.is_nil());
    if !root.is_absolute() || !owned {
        return Err("artifact requires owned UUID fixture".into());
    }
    let _root = crate::appcontainer_probe::verify_retirement_object(root)?;
    let _output = crate::appcontainer_probe::verify_retirement_object(&root.join("output"))?;
    let lease = ToolImageLease::open(&root.join("output/powershell-fixed-artifact.txt"))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(lease._file.0, &mut info) },
        "fixed artifact identity",
    )?;
    if info.nNumberOfLinks != 1 || lease.identity.bytes != 25 {
        return Err("fixed artifact link count or length differs".into());
    }
    if lease.read_bytes()? != b"fixed PowerShell artifact" {
        return Err("fixed PowerShell artifact content differs".into());
    }
    Ok(lease.identity.clone())
}
pub(crate) fn open_fixed_build_source(root: &Path) -> Result<ToolImageLease, String> {
    let source = ToolImageLease::open(&root.join("fixed-build.cs"))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(source._file.0, &mut info) },
        "fixed build source identity",
    )?;
    if info.nNumberOfLinks != 1
        || source.identity.bytes != FIXED_BUILD_SOURCE.len() as u64
        || source.read_bytes()? != FIXED_BUILD_SOURCE.as_bytes()
    {
        return Err("fixed build source content or link count differs".into());
    }
    Ok(source)
}
/// Static inspection only; the fixed child separately loads and invokes this DLL.
pub fn verify_powershell_build_dll(root: &Path) -> Result<ToolImageIdentity, String> {
    verify_powershell_artifact(root)?;
    let _root = crate::appcontainer_probe::verify_retirement_object(root)?;
    let _source = open_fixed_build_source(root)?;
    let _output = crate::appcontainer_probe::verify_retirement_object(&root.join("output"))?;
    let lease = ToolImageLease::open(&root.join("output/powershell-fixed-build.dll"))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(lease._file.0, &mut info) },
        "compiled DLL identity",
    )?;
    if info.nNumberOfLinks != 1 || !(512..=65536).contains(&lease.identity.bytes) {
        return Err("compiled DLL link count or size rejected".into());
    }
    let bytes = lease.read_bytes()?;
    let imports = crate::pe_imports::static_imports(&bytes)?;
    if imports != ["mscoree.dll"] {
        return Err("compiled DLL runtime imports differ".into());
    }
    let hash = ToolImageLease::open(&root.join("output/powershell-fixed-build.sha256"))?;
    let mut hash_info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(hash._file.0, &mut hash_info) },
        "compiled digest identity",
    )?;
    if hash_info.nNumberOfLinks != 1 || hash.identity.bytes != 64 {
        return Err("compiled digest link count or size rejected".into());
    }
    verify_compiled_digest(&bytes, &hash.read_bytes()?)?;
    Ok(lease.identity.clone())
}
fn verify_compiled_digest(bytes: &[u8], expected: &[u8]) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if expected.len() != 64
        || !expected
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(byte))
    {
        return Err("compiled digest encoding rejected".into());
    }
    let actual: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    if actual.as_bytes() != expected {
        return Err("compiled DLL differs from executed byte digest".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn build_source_creation_refuses_preexisting_file_and_hardlink_without_overwrite() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("fixed-build.cs");
        std::fs::write(&source, b"preexisting object").unwrap();
        assert!(create_fixed_build_source(&root).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"preexisting object");
        std::fs::hard_link(&source, root.join("alias.cs")).unwrap();
        assert!(create_fixed_build_source(&root).is_err());
        assert_eq!(
            std::fs::read(root.join("alias.cs")).unwrap(),
            b"preexisting object"
        );
        trash::delete(root).unwrap();
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let lease = create_fixed_build_source(&root).unwrap();
        assert_eq!(lease.read_bytes().unwrap(), FIXED_BUILD_SOURCE.as_bytes());
        assert!(create_fixed_build_source(&root).is_err());
        drop(lease);
        trash::delete(root).unwrap();
    }
    #[test]
    fn actual_dedicated_file_source_build_binds_success_to_exact_retirement() {
        for source_mode in [
            "source-file",
            "pinned-source",
            "source-write-denied",
            "owned-cwd",
        ] {
            let run_prefix = if matches!(source_mode, "source-write-denied" | "owned-cwd") {
                source_mode.to_owned()
            } else {
                format!("{source_mode}-build")
            };
            let read = |suffix: &str| -> serde_json::Value {
                serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-{run_prefix}-system-{suffix}.json"))).unwrap()).unwrap()
            };
            let receipt = read("profile");
            let report = &receipt["controller_admission_report"];
            assert!(receipt["error"].is_null() && report["error"].is_null());
            for field in [
                "actual_user_verified",
                "actual_package_verified",
                "actual_capabilities_verified",
                "actual_low_integrity",
                "actual_lpac",
                "execution_topology_verified",
                "process_tree_stopped",
            ] {
                assert_eq!(report[field], true, "{field}");
            }
            assert_eq!(report["tool_admission"]["actual_exit"], 73);
            assert_eq!(report["tool_admission"]["artifact_verified"], true);
            assert_eq!(report["tool_admission"]["build_dll_verified"], true);
            let retired = read("recovered-profile");
            assert_eq!(retired["fixture_id"], receipt["fixture_id"]);
            assert_eq!(retired["account_sid"], receipt["account_sid"]);
            for field in [
                "account_removed",
                "profile_removed",
                "filters_removed",
                "credential_removed",
            ] {
                assert_eq!(retired[field], true, "{field}");
            }
            assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
            let audit = read("os-audit");
            assert_eq!(audit["fixture_id"], receipt["fixture_id"]);
            for field in [
                "account_absent",
                "profile_absent",
                "hive_absent",
                "services_absent",
            ] {
                assert_eq!(audit[field], true, "{field}");
            }
        }
    }
    #[test]
    fn actual_git_init_keeps_source_success_and_lpac_failure_distinct() {
        let read = |name: &str| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../docs/design/evidence")
                        .join(name),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let source = read("windows-stage-a-2026-10-09-git-init-owned-cwd-source.json");
        assert_eq!(source["positive_control_passed"], true);
        assert_eq!(source["repository_verified"], true);
        let relative_source = read("windows-stage-a-2026-10-09-git-relative-init-source.json");
        assert_eq!(relative_source["positive_control_passed"], true);
        assert_eq!(relative_source["repository_verified"], true);
        assert_eq!(relative_source["fixture_recycled"], true);
        let relative_lpac = read("windows-stage-a-2026-10-09-git-relative-init-lpac.json");
        assert_eq!(relative_lpac["tool_admission"]["actual_exit"], 1);
        assert!(relative_lpac["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("cannot lock ref 'HEAD'"));
        assert!(!relative_lpac["error"].is_null());
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(relative_lpac[field], true, "relative {field}");
        }
        let lpac = read("windows-stage-a-2026-10-09-git-init-owned-cwd-lpac.json");
        assert_eq!(lpac["tool_admission"]["actual_exit"], 1);
        assert_ne!(lpac["tool_admission"]["repository_verified"], true);
        assert!(lpac["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("cannot lock ref 'HEAD'"));
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(lpac[field], true, "{field}");
        }
        assert!(verify_git_init(Path::new("relative")).is_err());
        let dedicated = read("windows-stage-a-2026-10-09-git-init-system-profile.json");
        assert_eq!(dedicated["controller_tool"], "git_bundle_init");
        let admission = &dedicated["controller_admission_report"];
        assert_eq!(admission["tool_admission"]["actual_exit"], 1);
        assert_eq!(admission["tool_admission"]["repository_verified"], false);
        assert_eq!(admission["process_tree_stopped"], true);
        assert_eq!(admission["execution_topology_verified"], true);
        assert!(!admission["error"].is_null());
        let recovery = read("windows-stage-a-2026-10-09-git-init-system-recovered-profile.json");
        assert_eq!(recovery["fixture_id"], dedicated["fixture_id"]);
        assert_eq!(recovery["account_sid"], dedicated["account_sid"]);
        assert!(recovery["cleanup_debt"].as_array().unwrap().is_empty());
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(recovery[field], true, "{field}");
        }
    }
    #[test]
    fn executed_digest_rejects_same_length_change_and_noncanonical_encoding() {
        let expected = b"BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        assert!(verify_compiled_digest(b"abc", expected).is_ok());
        assert!(verify_compiled_digest(b"abd", expected).is_err());
        assert!(verify_compiled_digest(b"abc", &expected[..63]).is_err());
        assert!(verify_compiled_digest(b"abc", &expected.to_ascii_lowercase()).is_err());
    }
    #[test]
    fn compiled_dll_gate_rejects_same_size_mutation_and_hardlink() {
        use sha2::{Digest, Sha256};
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("output")).unwrap();
        std::fs::write(root.join("fixed-build.cs"), FIXED_BUILD_SOURCE).unwrap();
        std::fs::write(
            root.join("output/powershell-fixed-artifact.txt"),
            b"fixed PowerShell artifact",
        )
        .unwrap();
        let mut bytes = crate::pe_imports::tests::fixture(true);
        bytes[576..589].fill(0);
        bytes[576..588].copy_from_slice(b"mscoree.dll\0");
        let dll = root.join("output/powershell-fixed-build.dll");
        std::fs::write(&dll, &bytes).unwrap();
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect();
        std::fs::write(root.join("output/powershell-fixed-build.sha256"), digest).unwrap();
        // This synthetic PE exercises static binding only, not CLR execution.
        assert!(verify_powershell_build_dll(&root).is_ok());
        std::fs::write(root.join("fixed-build.cs"), "different source").unwrap();
        assert!(verify_powershell_build_dll(&root)
            .err()
            .unwrap()
            .contains("source content"));
        std::fs::write(root.join("fixed-build.cs"), FIXED_BUILD_SOURCE).unwrap();
        bytes[1000] = 1;
        std::fs::write(&dll, &bytes).unwrap();
        assert!(verify_powershell_build_dll(&root)
            .err()
            .unwrap()
            .contains("executed byte digest"));
        bytes[1000] = 0;
        std::fs::write(&dll, &bytes).unwrap();
        std::fs::hard_link(&dll, root.join("aliased.dll")).unwrap();
        assert!(verify_powershell_build_dll(&root)
            .err()
            .unwrap()
            .contains("link count"));
        std::fs::hard_link(root.join("fixed-build.cs"), root.join("source-alias.cs")).unwrap();
        assert!(verify_powershell_build_dll(&root)
            .err()
            .unwrap()
            .contains("fixed build source"));
        trash::delete(root).unwrap();
    }
    #[test]
    fn persisted_build_requires_dll_and_same_owned_retirement() {
        let read = |name: &str| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../docs/design/evidence")
                        .join(name),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let source = read("windows-stage-a-2026-10-09-powershell7-persisted-build-source.json");
        assert_eq!(source["positive_control_passed"], true);
        assert_eq!(source["build_dll_verified"], true);
        let shared = read("windows-stage-a-2026-10-09-powershell7-persisted-build-lpac.json");
        assert!(shared["error"].is_null());
        assert_eq!(shared["tool_admission"]["build_dll_verified"], true);
        assert_eq!(shared["profile_removed"], true);
        assert_eq!(shared["fixture_acls_revoked"], true);
        let dedicated =
            read("windows-stage-a-2026-10-09-powershell7-persisted-build-system-profile.json");
        let admission = &dedicated["controller_admission_report"];
        assert!(admission["error"].is_null());
        for field in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(admission[field], true, "{field}");
        }
        assert_eq!(admission["tool_admission"]["build_dll_verified"], true);
        assert_eq!(admission["tool_admission"]["actual_exit"], 73);
        let recovery = read(
            "windows-stage-a-2026-10-09-powershell7-persisted-build-system-recovered-profile.json",
        );
        assert_eq!(dedicated["fixture_id"], recovery["fixture_id"]);
        assert_eq!(dedicated["account_sid"], recovery["account_sid"]);
        assert!(recovery["cleanup_debt"].as_array().unwrap().is_empty());
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(recovery[field], true, "{field}");
        }
    }
    #[test]
    fn compiled_dll_gate_rejects_missing_and_corrupt_pe() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("output")).unwrap();
        std::fs::write(root.join("fixed-build.cs"), FIXED_BUILD_SOURCE).unwrap();
        std::fs::write(
            root.join("output/powershell-fixed-artifact.txt"),
            b"fixed PowerShell artifact",
        )
        .unwrap();
        assert!(verify_powershell_build_dll(&root).is_err());
        let dll = root.join("output/powershell-fixed-build.dll");
        std::fs::write(&dll, vec![0; 2560]).unwrap();
        assert!(verify_powershell_build_dll(&root).is_err());
        std::fs::write(&dll, vec![0; 65537]).unwrap();
        assert!(verify_powershell_build_dll(&root).is_err());
        trash::delete(root).unwrap();
    }
    #[test]
    fn reference_copy_requires_dll_and_pins_both_owned_directories() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let references = root.join("ref");
        std::fs::create_dir(&references).unwrap();
        let source_path = root.join("source.dll");
        let bytes = crate::pe_imports::tests::fixture(true);
        std::fs::write(&source_path, &bytes).unwrap();
        let source = ToolImageLease::open(&source_path).unwrap();
        for name in [
            "pwsh.exe",
            "pwsh.deps.json",
            "../escape.dll",
            "nested/other.dll",
        ] {
            assert!(source.copy_new_owned(&references, name).is_err(), "{name}");
        }
        let copied = source
            .copy_new_owned(&references, "System.Runtime.dll")
            .unwrap();
        assert_eq!(copied.read_bytes().unwrap(), bytes);
        assert!(source
            .copy_new_owned(&references, "System.Runtime.dll")
            .is_err());
        assert!(std::fs::rename(&references, root.join("replaced-ref")).is_err());
        assert!(std::fs::rename(&root, root.with_extension("replaced")).is_err());
        assert!(references.join("System.Runtime.dll").is_file());
        drop(copied);
        drop(source);
        trash::delete(root).unwrap();
    }
    #[test]
    fn reference_copy_rejects_actual_junction_without_touching_target() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        let target =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("sentinel.txt"), b"owned target unchanged").unwrap();
        let source_path = root.join("source.dll");
        std::fs::write(&source_path, crate::pe_imports::tests::fixture(true)).unwrap();
        let source = ToolImageLease::open(&source_path).unwrap();
        let result = std::process::Command::new(r"C:\Windows\System32\cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(root.join("ref"))
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "junction setup: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(source
            .copy_new_owned(&root.join("ref"), "System.Runtime.dll")
            .is_err());
        assert_eq!(
            std::fs::read(target.join("sentinel.txt")).unwrap(),
            b"owned target unchanged"
        );
        assert!(!target.join("System.Runtime.dll").exists());
        drop(source);
        trash::delete(root).unwrap();
        trash::delete(target).unwrap();
    }
    #[test]
    fn fixed_build_receipts_distinguish_compiler_execution_from_missing_module() {
        let read = |name: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(name);
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
        };
        let source = read("windows-stage-a-2026-10-09-powershell7-build-source-control.json");
        assert_eq!(source["positive_control_passed"], true);
        assert_eq!(source["artifact_verified"], true);
        assert_eq!(source["actual_exit"], 73);
        let lpac =
            read("windows-stage-a-2026-10-09-powershell7-build-instrumentation-shared-source.json");
        assert_eq!(lpac["tool_admission"]["actual_exit"], 1);
        assert_eq!(lpac["tool_admission"]["topology_verified"], true);
        assert_ne!(lpac["tool_admission"]["artifact_verified"], true);
        assert!(lpac["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("Microsoft.PowerShell.Utility"));
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(lpac[field], true, "{field}");
        }
        assert!(!lpac["error"].is_null());
        let explicit_source =
            read("windows-stage-a-2026-10-09-powershell7-build-explicit-module-source.json");
        assert_eq!(explicit_source["positive_control_passed"], true);
        assert_eq!(explicit_source["artifact_verified"], true);
        let explicit_lpac =
            read("windows-stage-a-2026-10-09-powershell7-build-explicit-module-lpac.json");
        assert_eq!(explicit_lpac["tool_admission"]["actual_exit"], 1);
        assert_eq!(explicit_lpac["tool_admission"]["topology_verified"], true);
        assert!(explicit_lpac["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("\\ref'"));
        assert_ne!(explicit_lpac["tool_admission"]["artifact_verified"], true);
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(explicit_lpac[field], true, "{field}");
        }
    }
    #[test]
    fn artifact_gate_rejects_aliases_missing_and_changed_content() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("output")).unwrap();
        let artifact = root.join("output/powershell-fixed-artifact.txt");
        assert!(verify_powershell_artifact(&root).is_err());
        std::fs::write(&artifact, b"fixed PowerShell artifact").unwrap();
        assert_eq!(verify_powershell_artifact(&root).unwrap().bytes, 25);
        let alias = root.join("alias.txt");
        std::fs::hard_link(&artifact, &alias).unwrap();
        assert!(verify_powershell_artifact(&root)
            .err()
            .unwrap()
            .contains("link count"));
        trash::delete(&alias).unwrap();
        // Recycle-bin movement can retain a hardlink; use a fresh single-link object.
        std::fs::rename(&artifact, root.join("retained-original.txt")).unwrap();
        std::fs::write(&artifact, b"fixed PowerShell artifacX").unwrap();
        assert!(verify_powershell_artifact(&root).is_err());
        std::fs::write(&artifact, b"fixed PowerShell artifact!").unwrap();
        assert!(verify_powershell_artifact(&root)
            .err()
            .unwrap()
            .contains("length"));
        assert!(verify_powershell_artifact(Path::new("relative")).is_err());
        trash::delete(root).unwrap();
    }
    #[test]
    fn powershell7_real_receipts_keep_entry_and_dependency_failure_distinct() {
        let source: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-source-control.json"))).unwrap();
        assert_eq!(source["positive_control_passed"], true);
        let installed: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-lpac-controller.json"))).unwrap();
        let owned: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-owned-entry-lpac-controller.json"))).unwrap();
        assert_eq!(installed["tool_admission"]["actual_exit"], 0x80008085u32);
        assert_eq!(owned["tool_admission"]["actual_exit"], 0x8000809au32);
        assert!(installed["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("Failed to resolve full path"));
        assert!(owned["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("pwsh.dll"));
        assert_eq!(
            owned["tool_admission"]["owned_copy_source"],
            installed["tool_admission"]["image"]
        );
        assert_eq!(
            owned["tool_admission"]["image"]["bytes"],
            installed["tool_admission"]["image"]["bytes"]
        );
        for receipt in [&installed, &owned] {
            assert!(!receipt["error"].is_null());
            assert_eq!(receipt["tool_admission"]["topology_verified"], true);
            for field in [
                "process_tree_stopped",
                "fixture_acls_revoked",
                "profile_removed",
            ] {
                assert_eq!(receipt[field], true);
            }
        }
        assert!(FixedTool::from_cli("--run-lpac-powershell7-owned-entry extra").is_none());
        assert_eq!(
            FixedTool::PowerShell7OwnedEntry.command(),
            FixedTool::PowerShell7.command()
        );
        assert_eq!(FixedTool::PowerShell7.expected_exit(), 73);
    }
    #[test]
    fn version_output_rejects_missing_extra_or_corrupt_delivery() {
        assert!(verified_git_version_output(
            "git version 2.55.0.windows.3\n",
            ""
        ));
        assert!(verified_git_version_output(
            "git version 2.55.0.windows.3\r\n",
            ""
        ));
        for output in [
            "",
            "git version \n",
            "git version 2.55",
            "git version 2.55\nextra\n",
            "git version 2.55\0\n",
            "git version 2.55.0.windows.2\n",
            "git version 2.55.0.windows.4\n",
            "git version 2.55.0\n",
            "git version arbitrary\n",
        ] {
            assert!(!verified_git_version_output(output, ""));
        }
        assert!(!verified_git_version_output("git version 2.55\n", "error"));
    }
    #[test]
    fn owned_copy_preserves_bytes_locks_both_images_and_refuses_overwrite() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.exe");
        let data = crate::pe_imports::tests::fixture(true);
        std::fs::write(&source, &data).unwrap();
        let source_lease = ToolImageLease::open(&source).unwrap();
        let copied = source_lease.copy_new_owned(&root, "git.exe").unwrap();
        assert_eq!(copied.read_bytes().unwrap(), data);
        assert_ne!(copied.identity.file_index, source_lease.identity.file_index);
        assert_eq!(
            copied.static_imports().unwrap(),
            source_lease.static_imports().unwrap()
        );
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .is_err());
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(&copied.identity.path)
            .is_err());
        assert!(source_lease.copy_new_owned(&root, "git.exe").is_err());
        let renamed =
            root.with_file_name(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        assert!(std::fs::rename(&root, &renamed).is_err());
        for name in ["../escape.dll", "NUL.dll", "other.exe", "nested/file.dll"] {
            assert!(source_lease.copy_new_owned(&root, name).is_err(), "{name}");
        }
        assert!(source_lease
            .copy_new_owned(&root.join("source.exe"), "git.exe")
            .is_err());
        drop(copied);
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(root.join("git.exe"))
            .is_ok());
        assert_eq!(source_lease.read_bytes().unwrap(), data);
        drop(source_lease);
        trash::delete(root).unwrap();
    }
    #[test]
    fn stdio_is_exact_inheritable_handles_with_same_handle_read_budget() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("output")).unwrap();
        let stdio = ToolStdio::prepare(&root).unwrap();
        for handle in stdio.inherited {
            let mut flags = 0;
            assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
            assert_ne!(flags & HANDLE_FLAG_INHERIT, 0);
        }
        assert!(ToolStdio::prepare(&root).is_err());
        let data = b"fixed diagnostic";
        let mut written = 0;
        assert_ne!(
            unsafe {
                WriteFile(
                    stdio.inherited[2],
                    data.as_ptr(),
                    data.len() as u32,
                    &mut written,
                    null_mut(),
                )
            },
            0
        );
        assert_eq!(
            stdio.read_after_stop(FixedTool::Git).unwrap()[1],
            "fixed diagnostic"
        );
        assert_ne!(
            unsafe { SetFilePointerEx(stdio.inherited[2], 16385, null_mut(), FILE_BEGIN) },
            0
        );
        assert_ne!(unsafe { SetEndOfFile(stdio.inherited[2]) }, 0);
        assert!(stdio.read_after_stop(FixedTool::Git).is_err());
        drop(stdio);
        trash::delete(root).unwrap();
    }
    #[test]
    fn fixed_output_decoding_preserves_localized_diagnostic_and_rejects_truncation() {
        let data: Vec<_> = "类型初始值设定项引发异常"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            FixedTool::PowerShell.decode_output(&data).unwrap(),
            "类型初始值设定项引发异常"
        );
        assert!(FixedTool::PowerShell
            .decode_output(&data[..data.len() - 1])
            .is_err());
        assert!(FixedTool::Git.decode_output(&[255]).is_err());
        assert_eq!(FixedTool::Node.decode_output(b"").unwrap(), "");
    }
    #[test]
    fn image_lease_blocks_mutation_until_retirement() {
        let path =
            std::env::temp_dir().join(format!("ShellSpan-tool-lease-{}.exe", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"owned fixture only").unwrap();
        let lease = ToolImageLease::open(&path).unwrap();
        assert_eq!(lease.identity.bytes, 18);
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        drop(lease);
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_ok());
        trash::delete(&path).unwrap();
    }
    #[test]
    fn actual_node_ambient_preload_is_excluded_with_failure_control() {
        let read = |mode: &str| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                    "../../docs/design/evidence/windows-stage-a-2026-10-09-node-ambient-options-{mode}.json"
                )))
                .unwrap(),
            )
            .unwrap()
        };
        let control = read("control");
        assert_eq!(control["actual_exit"], 1);
        assert_eq!(control["missing_owned_module_observed"], true);
        assert_eq!(control["module_not_found_observed"], true);
        let source = read("source");
        let lpac = read("lpac");
        assert_eq!(source["actual_exit"], 73);
        assert_eq!(source["positive_control_passed"], true);
        assert_eq!(source["fixture_recycled"], true);
        assert_eq!(lpac["tool_admission"]["actual_exit"], 73);
        assert_eq!(lpac["tool_admission"]["tool"], "node");
        assert_eq!(lpac["tool_admission"]["stderr"], "");
        for receipt in [&source, &lpac] {
            assert!(receipt["error"].is_null());
            assert_eq!(receipt["process_tree_stopped"], true);
            assert!(receipt["topology_verified"]
                .as_bool()
                .unwrap_or_else(|| receipt["tool_admission"]["topology_verified"]
                    .as_bool()
                    .unwrap()));
        }
        assert_eq!(lpac["actual_lpac"], true);
        assert_eq!(lpac["profile_removed"], true);
        assert_eq!(lpac["fixture_acls_revoked"], true);
    }
    #[test]
    fn actual_node_owned_working_directory_receipts_bind_success_and_cleanup() {
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-node-cwd-assertion-source.json"
        ))
        .unwrap();
        let lpac: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-node-cwd-assertion-lpac.json"
        ))
        .unwrap();
        assert_eq!(source["actual_exit"], 73);
        assert_eq!(source["positive_control_passed"], true);
        assert_eq!(source["fixture_recycled"], true);
        assert_eq!(lpac["tool_admission"]["actual_exit"], 73);
        assert_eq!(lpac["tool_admission"]["tool"], "node");
        assert_eq!(lpac["tool_admission"]["topology_verified"], true);
        for key in [
            "actual_lpac",
            "low_integrity",
            "same_user",
            "capabilities_verified",
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(lpac[key], true, "receipt field {key}");
        }
        assert!(source["error"].is_null());
        assert!(lpac["error"].is_null());
        assert_eq!(lpac["production"], "unavailable");
        let dedicated: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-node-cwd-assertion-system-profile.json"
        ))
        .unwrap();
        let recovered: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-node-cwd-assertion-system-recovered-profile.json"
        ))
        .unwrap();
        let audit: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-node-cwd-assertion-system-os-audit.json"
        ))
        .unwrap();
        let admission = &dedicated["controller_admission_report"];
        assert_eq!(admission["tool_admission"]["actual_exit"], 73);
        assert_eq!(admission["tool_admission"]["tool"], "node");
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(admission[key], true, "dedicated receipt field {key}");
        }
        assert!(admission["error"].is_null());
        assert_eq!(dedicated["fixture_id"], recovered["fixture_id"]);
        assert_eq!(dedicated["account_sid"], recovered["account_sid"]);
        assert_eq!(dedicated["fixture_id"], audit["fixture_id"]);
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(recovered[key], true, "recovery field {key}");
        }
        assert_eq!(recovered["cleanup_debt"], serde_json::json!([]));
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "OS audit field {key}");
        }
    }
    #[test]
    fn tool_contract_has_no_arbitrary_path_or_command() {
        assert!(FixedTool::from_cli("node.exe -e arbitrary").is_none());
        assert!(FixedTool::from_cli("--run-lpac-node-admission extra").is_none());
        assert!(FixedTool::from_cli("--run-lpac-powershell-admission").is_some());
        assert!(FixedTool::PowerShell
            .command()
            .contains("-NoProfile -NonInteractive"));
        assert_eq!(FixedTool::Git.expected_exit(), 0);
        assert_eq!(FixedTool::Node.expected_exit(), 73);
        assert!(ToolImageLease::open(Path::new("relative.exe")).is_err());
        assert!(ToolImageLease::open(&std::env::temp_dir()).is_err());
    }
}
