//! Authenticated numeric display I/O shared by the app and real editor fixtures.
//! This module has no NIP, input writer, command, lease or execution state.
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Pipes::{
    GetNamedPipeServerProcessId, PeekNamedPipe, SetNamedPipeHandleState, PIPE_NOWAIT,
    PIPE_READMODE_BYTE,
};
pub(crate) fn read_exact(
    file: &mut File,
    bytes: &mut [u8],
    stopped: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        if stopped.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("TERMINAL_DISPLAY_ORIGIN_CANCELLED".into());
        }
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                file.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("TERMINAL_DISPLAY_ORIGIN_CLOSED".into());
        }
        if available == 0 {
            thread::sleep(Duration::from_millis(5));
            continue;
        }
        let count = (available as usize).min(bytes.len() - offset);
        let read = file
            .read(&mut bytes[offset..offset + count])
            .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_CLOSED")?;
        if read == 0 {
            return Err("TERMINAL_DISPLAY_ORIGIN_CLOSED".into());
        }
        offset += read;
    }
    Ok(())
}

pub(crate) fn write_all_nonblocking(
    file: &mut File,
    bytes: &[u8],
    stopped: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        if stopped.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("TERMINAL_DISPLAY_ORIGIN_CLOSED".into());
        }
        match file.write(&bytes[offset..]) {
            Ok(0) => thread::sleep(Duration::from_millis(5)),
            Ok(written) => offset += written,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err("TERMINAL_DISPLAY_ORIGIN_CLOSED".into()),
        }
    }
    Ok(())
}
pub(crate) fn decode_request(bytes: &[u8; 20]) -> Result<(u32, [u16; 4]), String> {
    if &bytes[..8] != b"SSDO\x02\0\0\0" {
        return Err("TERMINAL_DISPLAY_ORIGIN_PROTOCOL".into());
    }
    let index = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_PROTOCOL")?,
    );
    let number = |at| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let geometry = [number(12), number(14), number(16), number(18)];
    if index == 0
        || index > i32::MAX as u32
        || (geometry[0] == 0
            || geometry[1] == 0
            || geometry[2] >= geometry[0]
            || geometry[3] >= geometry[1])
    {
        return Err("TERMINAL_DISPLAY_ORIGIN_INVALID".into());
    }
    Ok((index, geometry))
}
pub(crate) fn response(index: u32, widths: Option<(Vec<u8>, bool)>) -> Vec<u8> {
    let mut bytes = Vec::from(&b"SSDO\x02\0\0\0"[..]);
    bytes[5] = u8::from(widths.is_some());
    bytes.extend_from_slice(&index.to_le_bytes());
    let (widths, wrap_pending) = widths.unwrap_or_default();
    bytes[6] = u8::from(wrap_pending);
    bytes.extend_from_slice(&(widths.len() as u32).to_le_bytes());
    bytes.extend(widths);
    bytes
}

pub(crate) fn connect(
    pipe_path: &str,
    expected_host_pid: u32,
    stop: &AtomicBool,
) -> Result<File, String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let file = loop {
        if stop.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("TERMINAL_DISPLAY_ORIGIN_CANCELLED".into());
        }
        match OpenOptions::new().read(true).write(true).open(pipe_path) {
            Ok(file) => break file,
            Err(_) => thread::sleep(Duration::from_millis(5)),
        }
    };
    let mut host_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(file.as_raw_handle(), &mut host_pid) } == 0
        || host_pid != expected_host_pid
    {
        return Err("TERMINAL_DISPLAY_ORIGIN_PEER_MISMATCH".into());
    }
    let mode = PIPE_NOWAIT | PIPE_READMODE_BYTE;
    if unsafe {
        SetNamedPipeHandleState(
            file.as_raw_handle(),
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err("TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE".into());
    }
    Ok(file)
}
