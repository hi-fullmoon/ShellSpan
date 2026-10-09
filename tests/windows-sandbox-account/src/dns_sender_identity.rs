//! Socket attribution only: it does not prove the original RPC caller identity.
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
use windows_sys::Win32::NetworkManagement::IpHelper::*;

pub fn tcp_sender_pid(stream: &TcpStream) -> Result<u32, String> {
    let (SocketAddr::V4(local), SocketAddr::V4(peer)) = (
        stream.local_addr().map_err(|e| e.to_string())?,
        stream.peer_addr().map_err(|e| e.to_string())?,
    ) else {
        return Err("DNS attribution requires owned IPv4 endpoints".into());
    };
    if *local.ip() != Ipv4Addr::LOCALHOST
        || local.port() != 53
        || *peer.ip() != Ipv4Addr::LOCALHOST
        || peer.port() == 0
    {
        return Err("DNS attribution requires accepted fixed loopback port 53".into());
    }
    let mut size = 0;
    let first = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            2,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("DNS TCP ownership sizing failed: {first}"));
    }
    for _ in 0..2 {
        if !(4..=1048576).contains(&size) {
            return Err("DNS TCP ownership table exceeds budget".into());
        }
        let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        let capacity = size;
        let code = unsafe {
            GetExtendedTcpTable(
                storage.as_mut_ptr().cast(),
                &mut size,
                0,
                2,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if code == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if code != 0 || size > capacity || size < 4 {
            return Err(format!("DNS TCP ownership query unconfirmed: {code}"));
        }
        let count = unsafe { *storage.as_ptr().cast::<u32>() } as usize;
        let bytes = count
            .checked_mul(std::mem::size_of::<MIB_TCPROW_OWNER_PID>())
            .and_then(|n| n.checked_add(4))
            .ok_or("DNS TCP ownership table overflow")?;
        if bytes > size as usize {
            return Err("DNS TCP ownership table truncated".into());
        }
        let rows = unsafe {
            std::slice::from_raw_parts(
                storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(4)
                    .cast::<MIB_TCPROW_OWNER_PID>(),
                count,
            )
        };
        let mut matches = rows.iter().filter(|row| {
            row.dwState == 5
                && row.dwLocalAddr.to_ne_bytes() == peer.ip().octets()
                && row.dwRemoteAddr.to_ne_bytes() == local.ip().octets()
                && u16::from_be(row.dwLocalPort as u16) == peer.port()
                && u16::from_be(row.dwRemotePort as u16) == 53
        });
        let found = matches.next().ok_or("DNS TCP sender owner unavailable")?;
        if found.dwOwningPid == 0 || matches.next().is_some() {
            return Err("DNS TCP sender owner ambiguous".into());
        }
        return Ok(found.dwOwningPid);
    }
    Err("DNS TCP ownership table changed beyond retry budget".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires exclusive owned loopback TCP port 53"]
    fn actual_owned_tcp_connection_is_attributed_to_sender_process() {
        let listener = std::net::TcpListener::bind("127.0.0.1:53").unwrap();
        let sender = TcpStream::connect("127.0.0.1:53").unwrap();
        let (receiver, _) = listener.accept().unwrap();
        assert_eq!(tcp_sender_pid(&receiver).unwrap(), std::process::id());
        drop(sender);
    }
}
