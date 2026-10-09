//! Read-only admission probes for the exact API-derived AppContainer namespace.
use std::ptr::null_mut;
use windows_sys::Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem::NtOpenDirectoryObject};
use windows_sys::Win32::Storage::FileSystem::READ_CONTROL;
use windows_sys::Win32::{
    Foundation::*,
    Security::{Isolation::GetAppContainerNamedObjectPath, PSID},
};

pub(super) fn inspect(package: PSID) -> serde_json::Value {
    let mut buffer = [0u16; 1024];
    let mut count = 0;
    if unsafe {
        GetAppContainerNamedObjectPath(
            null_mut(),
            package,
            buffer.len() as u32,
            buffer.as_mut_ptr(),
            &mut count,
        )
    } == 0
    {
        return serde_json::json!({"path_query_error":unsafe { GetLastError() }});
    }
    let Some(length) = buffer.iter().position(|unit| *unit == 0) else {
        return serde_json::json!({"path_query_error":"unterminated API result"});
    };
    let relative = String::from_utf16_lossy(&buffer[..length]);
    if !relative.starts_with("AppContainerNamedObjects\\S-1-15-2-") || relative.contains("..") {
        return serde_json::json!({"path_query_error":"unexpected API namespace shape"});
    }
    let mut session = 0;
    if unsafe {
        windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
            windows_sys::Win32::System::Threading::GetCurrentProcessId(),
            &mut session,
        )
    } == 0
    {
        return serde_json::json!({"session_query_error":unsafe { GetLastError() }});
    }
    let path = format!(r"\Sessions\{session}\BaseNamedObjects\{relative}");
    let paths = [
        Some(path.as_str()),
        path.rsplit_once('\\').map(|(parent, _)| parent),
    ];
    let observations: Vec<_> = paths.into_iter().flatten().map(|path| {
        let mut name: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let mut unicode = UNICODE_STRING { Length: ((name.len()-1)*2) as u16,
            MaximumLength:(name.len()*2) as u16, Buffer:name.as_mut_ptr() };
        let attributes = OBJECT_ATTRIBUTES {Length:std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            ObjectName:&mut unicode,Attributes:0x40,..Default::default()};
        let open = |access| {
            let mut handle = null_mut();
            let code = unsafe { NtOpenDirectoryObject(&mut handle, access, &attributes) };
            if code >= 0 { unsafe { CloseHandle(handle); } }
            format!("0x{:08x}", code as u32)
        };
        serde_json::json!({"path":path,"read_control":open(READ_CONTROL),"traverse":open(2),"create_subdirectory_admission":open(8)})
    }).collect();
    serde_json::json!({"read_only":true,"observations":observations})
}
