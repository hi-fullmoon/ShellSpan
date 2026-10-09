//! Fixed owned DNS wire fixture. Never forwards queries or resolves user names.
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

pub fn write_tcp_packet(writer: &mut impl std::io::Write, packet: &[u8]) -> Result<()> {
    if !(12..=512).contains(&packet.len()) {
        return Err("DNS TCP packet outside fixed budget".into());
    }
    writer
        .write_all(&(packet.len() as u16).to_be_bytes())
        .map_err(|e| e.to_string())?;
    writer.write_all(packet).map_err(|e| e.to_string())
}

pub fn read_tcp_packet(reader: &mut impl std::io::Read) -> Result<Vec<u8>> {
    let mut header = [0u8; 2];
    reader.read_exact(&mut header).map_err(|e| e.to_string())?;
    let length = usize::from(u16::from_be_bytes(header));
    if !(12..=512).contains(&length) {
        return Err("DNS TCP declared length outside fixed budget".into());
    }
    let mut packet = vec![0; length];
    reader.read_exact(&mut packet).map_err(|e| e.to_string())?;
    Ok(packet)
}

pub fn fixed_query(id: Uuid, transaction: u16) -> Result<Vec<u8>> {
    if id.is_nil() {
        return Err("DNS fixture requires nonnil owned UUID".into());
    }
    let mut packet = Vec::from(transaction.to_be_bytes());
    packet.extend([1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in [format!("sspa-{}", id.simple()), "invalid".to_string()] {
        packet.push(u8::try_from(label.len()).map_err(|_| "DNS label exceeds budget")?);
        packet.extend(label.as_bytes());
    }
    packet.extend([0, 0, 1, 0, 1]);
    Ok(packet)
}

pub fn fixed_response(id: Uuid, request: &[u8]) -> Result<Vec<u8>> {
    if request.len() < 2 || request.len() > 512 {
        return Err("DNS request length outside fixed budget".into());
    }
    let transaction = u16::from_be_bytes([request[0], request[1]]);
    let expected = fixed_query(id, transaction)?;
    if request != expected {
        return Err("DNS query differs from fixed owned question".into());
    }
    let mut response = expected;
    response[2..4].copy_from_slice(&[0x81, 0x80]);
    response[6..8].copy_from_slice(&[0, 1]);
    // Compression refers only to the original fixed question. TTL zero avoids
    // retaining a diagnostic answer. 127.0.0.42 is data, never a traffic target.
    response.extend([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 42]);
    Ok(response)
}

pub fn verify_fixed_answer(id: Uuid, transaction: u16, response: &[u8]) -> bool {
    fixed_query(id, transaction)
        .and_then(|query| fixed_response(id, &query))
        .is_ok_and(|expected| response == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcp_declared_lengths_are_bounded_before_payload_read() {
        for length in [0u16, 11, 513, u16::MAX] {
            let mut input = std::io::Cursor::new(length.to_be_bytes());
            assert!(read_tcp_packet(&mut input).unwrap_err().contains("budget"));
            assert_eq!(input.position(), 2);
        }
        assert!(read_tcp_packet(&mut std::io::Cursor::new([0, 12, 1])).is_err());
        assert!(write_tcp_packet(&mut Vec::new(), &[0; 513]).is_err());
    }

    #[test]
    fn real_tcp_fixture_handles_fragmented_fixed_query_and_exact_response() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::time::Duration;
        let id = Uuid::new_v4();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(1)).unwrap();
        let (mut accepted, _) = server.accept().unwrap();
        for stream in [&client, &accepted] {
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
        }
        let worker = std::thread::spawn(move || {
            let question = read_tcp_packet(&mut accepted).unwrap();
            write_tcp_packet(&mut accepted, &fixed_response(id, &question).unwrap()).unwrap();
        });
        let query = fixed_query(id, 19).unwrap();
        let mut frame = Vec::new();
        write_tcp_packet(&mut frame, &query).unwrap();
        for fragment in frame.chunks(3) {
            client.write_all(fragment).unwrap();
        }
        let answer = read_tcp_packet(&mut client).unwrap();
        assert!(verify_fixed_answer(id, 19, &answer));
        worker.join().unwrap();
    }

    #[test]
    fn owned_question_and_answer_reject_other_names_types_flags_and_transactions() {
        let id = Uuid::new_v4();
        let query = fixed_query(id, 42).unwrap();
        let response = fixed_response(id, &query).unwrap();
        assert!(verify_fixed_answer(id, 42, &response));
        assert!(!verify_fixed_answer(id, 43, &response));
        assert!(!verify_fixed_answer(Uuid::new_v4(), 42, &response));
        assert!(fixed_query(Uuid::nil(), 42).is_err());
        for index in [2, 4, 12, query.len() - 3, query.len() - 1] {
            let mut changed = query.clone();
            changed[index] ^= 1;
            assert!(
                fixed_response(id, &changed).is_err(),
                "changed byte {index}"
            );
        }
        assert!(fixed_response(id, &query[..query.len() - 1]).is_err());
        let mut extended = query;
        extended.push(0);
        assert!(fixed_response(id, &extended).is_err());
        assert!(fixed_response(id, &[0; 513]).is_err());
    }

    #[test]
    fn real_udp_fixture_round_trip_requires_the_exact_owned_answer() {
        use std::net::UdpSocket;
        use std::time::Duration;
        let id = Uuid::new_v4();
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let mut packet = [0u8; 513];
            let (length, peer) = server.recv_from(&mut packet).unwrap();
            let response = fixed_response(id, &packet[..length]).unwrap();
            server.send_to(&response, peer).unwrap();
        });
        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        client
            .send_to(&fixed_query(id, 7).unwrap(), address)
            .unwrap();
        let mut answer = [0u8; 513];
        let (length, peer) = client.recv_from(&mut answer).unwrap();
        assert_eq!(peer, address);
        assert!(verify_fixed_answer(id, 7, &answer[..length]));
        worker.join().unwrap();
    }
}
