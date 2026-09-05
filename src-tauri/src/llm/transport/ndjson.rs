use super::ensure_provider_stream_frame_size;

pub(crate) fn take_line(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    let Some(index) = buffer.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    ensure_provider_stream_frame_size(index)?;
    let mut line = buffer.drain(..index).collect::<Vec<_>>();
    buffer.drain(..1);
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|error| format!("invalid UTF-8 in Ollama stream event: {error}"))
}
