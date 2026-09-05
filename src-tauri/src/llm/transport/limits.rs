pub(crate) const MAX_ERROR_BODY_BYTES: usize = 4 * 1024;
pub(crate) const MAX_PROVIDER_NON_STREAM_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_PROVIDER_STREAM_EVENT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_PROVIDER_STREAM_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) const ERROR_BODY_LIMIT_MESSAGE: &str =
    "AI provider HTTP error body exceeded the 4 KiB response limit";
pub(crate) const NON_STREAM_BODY_LIMIT_MESSAGE: &str =
    "AI provider response exceeded the 1 MiB non-streaming limit";

pub(crate) fn append_provider_stream_chunk(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
    response_bytes: &mut usize,
) -> Result<(), String> {
    *response_bytes = (*response_bytes)
        .checked_add(chunk.len())
        .ok_or_else(|| "AI provider stream size overflowed".to_string())?;
    if *response_bytes > MAX_PROVIDER_STREAM_RESPONSE_BYTES {
        return Err("AI provider stream exceeded the 16 MiB response limit".to_string());
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

pub(crate) fn ensure_provider_stream_frame_size(frame_bytes: usize) -> Result<(), String> {
    if frame_bytes > MAX_PROVIDER_STREAM_EVENT_BYTES {
        Err("AI provider stream event exceeded the 1 MiB framing limit".to_string())
    } else {
        Ok(())
    }
}
