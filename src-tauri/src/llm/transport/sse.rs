use super::ensure_provider_stream_frame_size;

pub(crate) fn take_sse_event(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    let lf = find_bytes(buffer, b"\n\n").map(|index| (index, 2));
    let crlf = find_bytes(buffer, b"\r\n\r\n").map(|index| (index, 4));
    let Some((index, separator_len)) = earliest_separator(lf, crlf) else {
        return Ok(None);
    };
    ensure_provider_stream_frame_size(index)?;
    let event = buffer.drain(..index).collect::<Vec<_>>();
    buffer.drain(..separator_len);
    String::from_utf8(event)
        .map(Some)
        .map_err(|error| format!("invalid UTF-8 in OpenAI stream event: {error}"))
}

pub(crate) fn take_final_sse_event(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    if buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
        buffer.clear();
        return Ok(None);
    }
    ensure_provider_stream_frame_size(buffer.len())?;
    String::from_utf8(std::mem::take(buffer))
        .map(Some)
        .map_err(|error| format!("invalid UTF-8 in final AI stream event: {error}"))
}

pub(crate) fn sse_data(event: &str) -> String {
    event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n")
}

fn find_bytes(buffer: &[u8], needle: &[u8]) -> Option<usize> {
    buffer
        .windows(needle.len())
        .position(|window| window == needle)
}

fn earliest_separator(
    first: Option<(usize, usize)>,
    second: Option<(usize, usize)>,
) -> Option<(usize, usize)> {
    match (first, second) {
        (Some(first), Some(second)) => Some(if first.0 <= second.0 { first } else { second }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}
