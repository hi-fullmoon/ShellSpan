//! Image admission owns bytes; durable events own only verified immutable references.
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{ModelMessage, ModelRequest};
use crate::ai::{AiProviderConfig, AiProviderKind};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisionContract {
    pub version: u32,
    pub source_mime_types: Vec<String>,
    pub max_source_bytes: usize,
    pub max_batch_bytes: usize,
    pub max_images: usize,
    pub max_source_pixels: u64,
    pub max_source_dimension: u32,
    pub max_decode_bytes: u64,
    pub max_frames: usize,
    pub max_normalized_pixels: u64,
    pub max_normalized_dimension: u32,
    pub max_normalized_bytes: usize,
    pub routes: Vec<VisionRoute>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisionRoute {
    profile: String,
    kind: String,
    models: Vec<String>,
    pub context_window: u64,
    pub max_request_images: usize,
    pub max_request_image_bytes: u64,
    pub reserved_tokens_per_image: u64,
}
pub(crate) static VISION: LazyLock<VisionContract> = LazyLock::new(|| {
    let value: VisionContract =
        serde_json::from_str(include_str!("../../../src/lib/vision-contract.json"))
            .expect("shared vision contract");
    assert_eq!(value.version, 1);
    assert_eq!(value.max_frames, 1);
    value
});
pub(crate) fn vision_route(provider: &AiProviderConfig) -> Result<&'static VisionRoute, String> {
    VISION.routes.iter().find(|route| {
        provider.kind == AiProviderKind::OpenAiCompatible && route.kind == "openAiCompatible"
            && route.profile == super::provider::profile_id(provider)
            && route.models.iter().any(|model| model == &provider.model.trim().to_ascii_lowercase())
    }).ok_or_else(|| "IMAGE_MODEL_UNSUPPORTED: choose Qwen qwen3-vl-plus or qwen3-vl-flash; unknown/text-only models cannot receive images".into())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageRef {
    pub version: u32,
    pub sha256: String,
    pub media_type: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub name: String,
}
impl ImageRef {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.media_type != "image/png"
            || self.bytes == 0
            || self.bytes > VISION.max_normalized_bytes as u64
            || self.width == 0
            || self.height == 0
            || u64::from(self.width) * u64::from(self.height) > VISION.max_normalized_pixels
            || self.width.max(self.height) > VISION.max_normalized_dimension
            || clean_name(&self.name)? != self.name
        {
            return Err("IMAGE_REFERENCE_INVALID".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageUpload {
    pub media_type: String,
    pub data: String,
    pub name: String,
}
pub(crate) fn validate_upload_envelope(uploads: &[ImageUpload]) -> Result<(), String> {
    if uploads.is_empty() || uploads.len() > VISION.max_images {
        return Err("IMAGE_COUNT_LIMIT".into());
    }
    let mut total = 0usize;
    for upload in uploads {
        if upload.data.len() > VISION.max_source_bytes.div_ceil(3) * 4 {
            return Err("IMAGE_SOURCE_LIMIT".into());
        }
        clean_name(&upload.name)?;
        total = total
            .checked_add(upload.data.len())
            .ok_or("IMAGE_BATCH_LIMIT")?;
    }
    if total > VISION.max_batch_bytes.div_ceil(3) * 4 + uploads.len() * 4 {
        return Err("IMAGE_BATCH_LIMIT".into());
    }
    Ok(())
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageSubmission {
    pub session_id: String,
    pub client_operation_id: String,
    pub content: String,
    pub lane: super::AgentInboxLane,
    pub images: Vec<ImageUpload>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageOperation {
    pub session_id: String,
    pub client_operation_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImagePreviewRequest {
    pub session_id: String,
    pub sha256: String,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn clean_name(name: &str) -> Result<String, String> {
    if name.len() > 256 || name.chars().any(char::is_control) {
        return Err("IMAGE_NAME_INVALID: maximum 256 UTF-8 bytes; no control characters".into());
    }
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let leaf = if leaf.is_empty() { "image.png" } else { leaf };
    Ok(crate::redaction::redact_sensitive_text(leaf))
}
fn cancelled(token: &CancellationToken) -> Result<(), String> {
    if token.is_cancelled() {
        Err("IMAGE_CANCELLED".into())
    } else {
        Ok(())
    }
}
fn image_error(error: impl std::fmt::Display) -> String {
    format!("IMAGE_INVALID: {error}")
}

/// Reject animation, unsupported colour profiles and oversized decoded data before raster allocation.
/// Unprofiled RGB/gray samples are interpreted as sRGB; EXIF orientation is applied, descriptive
/// metadata removed, 16-bit samples reduced to RGBA8. Never reinterpret a non-sRGB ICC profile.
fn normalize(
    upload: &ImageUpload,
    token: &CancellationToken,
) -> Result<(ImageRef, Vec<u8>), String> {
    cancelled(token)?;
    if !VISION.source_mime_types.contains(&upload.media_type)
        || upload.data.is_empty()
        || upload.data.len() > VISION.max_source_bytes.div_ceil(3) * 4
    {
        return Err("IMAGE_SOURCE_LIMIT_OR_MIME".into());
    }
    let bytes = STANDARD.decode(&upload.data).map_err(image_error)?;
    if bytes.len() > VISION.max_source_bytes || STANDARD.encode(&bytes) != upload.data {
        return Err("IMAGE_BASE64_INVALID_OR_TOO_LARGE".into());
    }
    let format = image::guess_format(&bytes).map_err(image_error)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) || format.to_mime_type() != upload.media_type
    {
        return Err("IMAGE_MIME_MISMATCH".into());
    }
    if (format == ImageFormat::Jpeg && !bytes.ends_with(&[0xff, 0xd9]))
        || (format == ImageFormat::Gif && bytes.last() != Some(&0x3b))
        || (format == ImageFormat::WebP
            && (bytes.len() < 12
                || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len()))
    {
        return Err("IMAGE_CONTAINER_TRUNCATED_OR_TRAILING".into());
    }
    if format == ImageFormat::Jpeg {
        // Four-component (CMYK/YCCK) JPEGs have no unambiguous sRGB interpretation here.
        let mut offset = 2;
        while offset + 4 <= bytes.len() && bytes[offset] == 0xff {
            let marker = bytes[offset + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            if marker == 0xff {
                offset += 1;
                continue;
            }
            let len =
                u16::from_be_bytes(bytes[offset + 2..offset + 4].try_into().unwrap()) as usize;
            if len < 2 || offset + 2 + len > bytes.len() {
                return Err("IMAGE_INVALID_JPEG_SEGMENT".into());
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
                && (len < 8 || bytes[offset + 9] > 3)
            {
                return Err("IMAGE_COLOR_PROFILE_UNSUPPORTED".into());
            }
            offset += 2 + len;
        }
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(VISION.max_source_dimension);
    limits.max_image_height = Some(VISION.max_source_dimension);
    limits.max_alloc = Some(VISION.max_decode_bytes);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(image_error)?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > VISION.max_source_pixels
        || decoder.total_bytes() > VISION.max_decode_bytes
    {
        return Err("IMAGE_PIXEL_LIMIT".into());
    }
    if decoder.icc_profile().map_err(image_error)?.is_some() {
        return Err("IMAGE_COLOR_PROFILE_UNSUPPORTED: export as unprofiled sRGB first".into());
    }
    // PNG gamma/chromaticity/cICP are not safely interpreted by every decoder. Fail closed for
    // non-sRGB declarations rather than strip a profile and silently change visual meaning.
    if format == ImageFormat::Png {
        let mut offset = 8usize;
        let mut ended = false;
        while offset + 12 <= bytes.len() {
            let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let end = offset
                .checked_add(12)
                .and_then(|n| n.checked_add(len))
                .filter(|n| *n <= bytes.len())
                .ok_or("IMAGE_INVALID_PNG_CHUNK")?;
            let tag = &bytes[offset + 4..offset + 8];
            let data = &bytes[offset + 8..end - 4];
            if tag == b"acTL" {
                return Err("IMAGE_ANIMATION_UNSUPPORTED".into());
            }
            if tag == b"cICP"
                || tag == b"cHRM"
                || (tag == b"gAMA" && data != 45455u32.to_be_bytes())
            {
                return Err("IMAGE_COLOR_PROFILE_UNSUPPORTED".into());
            }
            offset = end;
            if tag == b"IEND" {
                ended = true;
                break;
            }
        }
        if !ended || offset != bytes.len() {
            return Err("IMAGE_INVALID_PNG_END".into());
        }
    }
    if format == ImageFormat::WebP
        && image::codecs::webp::WebPDecoder::new(Cursor::new(&bytes))
            .map_err(image_error)?
            .has_animation()
    {
        return Err("IMAGE_ANIMATION_UNSUPPORTED".into());
    }
    if format == ImageFormat::Gif {
        let mut gif =
            image::codecs::gif::GifDecoder::new(Cursor::new(&bytes)).map_err(image_error)?;
        gif.set_limits(limits).map_err(image_error)?;
        let mut frames = gif.into_frames();
        frames
            .next()
            .ok_or("IMAGE_INVALID_EMPTY_GIF")?
            .map_err(image_error)?;
        if frames.next().transpose().map_err(image_error)?.is_some() {
            return Err("IMAGE_ANIMATION_UNSUPPORTED".into());
        }
    }
    let orientation = decoder.orientation().map_err(image_error)?;
    let mut raster = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    cancelled(token)?;
    raster.apply_orientation(orientation);
    let scale = ((VISION.max_normalized_pixels as f64
        / (raster.width() as f64 * raster.height() as f64))
        .sqrt())
    .min(VISION.max_normalized_dimension as f64 / raster.width().max(raster.height()) as f64)
    .min(1.0);
    if scale < 1.0 {
        raster = raster.resize_exact(
            (raster.width() as f64 * scale).floor().max(1.0) as u32,
            (raster.height() as f64 * scale).floor().max(1.0) as u32,
            image::imageops::FilterType::Triangle,
        );
    }
    raster = DynamicImage::ImageRgba8(raster.to_rgba8());
    let mut output = Cursor::new(Vec::new());
    raster
        .write_to(&mut output, ImageFormat::Png)
        .map_err(image_error)?;
    let output = output.into_inner();
    let reference = ImageRef {
        version: 1,
        sha256: digest(&output),
        media_type: "image/png".into(),
        bytes: output.len() as u64,
        width: raster.width(),
        height: raster.height(),
        name: clean_name(&upload.name)?,
    };
    reference.validate()?;
    cancelled(token)?;
    Ok((reference, output))
}

#[derive(Default)]
struct ImageStoreInner {
    root: Option<PathBuf>,
}
#[derive(Clone)]
pub(crate) struct ImageStore {
    inner: Arc<Mutex<ImageStoreInner>>,
    imports: Arc<tokio::sync::Semaphore>,
    /// Held across the final Inbox append, linearizing cancellation with commit.
    pub(crate) operations: Arc<Mutex<HashMap<(String, String), CancellationToken>>>,
    #[cfg(test)]
    pub(crate) observer: Arc<Mutex<Option<ImageBoundaryObserver>>>,
}
impl Default for ImageStore {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            imports: Arc::new(tokio::sync::Semaphore::new(2)),
            operations: Arc::default(),
            #[cfg(test)]
            observer: Arc::default(),
        }
    }
}
#[cfg(test)]
type ImageBoundaryObserver = Arc<dyn Fn(&str) + Send + Sync>;
impl ImageStore {
    pub(crate) fn import_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        self.imports
            .clone()
            .try_acquire_owned()
            .map_err(|_| "IMAGE_IMPORT_BUSY: retry after the current import".into())
    }
    pub(crate) fn boundary(&self, stage: &str, token: &CancellationToken) -> Result<(), String> {
        #[cfg(test)]
        if let Some(observer) = self.observer.lock().unwrap().clone() {
            observer(stage);
        }
        let _ = stage;
        cancelled(token)
    }
    pub(crate) fn configure(&self, root: &Path) -> Result<(), String> {
        let root = root.join("agent-runtime/images-v1");
        let mut inner = self.inner.lock().map_err(|_| "IMAGE_STORE_UNAVAILABLE")?;
        if let Some(existing) = &inner.root {
            return if *existing == root {
                Ok(())
            } else {
                Err("IMAGE_ROOT_CHANGED".into())
            };
        }
        fs::create_dir_all(&root).map_err(image_error)?;
        if fs::symlink_metadata(&root)
            .map_err(image_error)?
            .file_type()
            .is_symlink()
        {
            return Err("IMAGE_ROOT_SYMLINK".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(image_error)?;
        }
        inner.root = Some(root);
        Ok(())
    }
    fn root(&self) -> Result<PathBuf, String> {
        self.inner
            .lock()
            .map_err(|_| "IMAGE_STORE_UNAVAILABLE")?
            .root
            .clone()
            .ok_or_else(|| "IMAGE_STORE_NOT_CONFIGURED".into())
    }
    pub(crate) fn token(&self, operation: &ImageOperation) -> Result<CancellationToken, String> {
        super::session::validate_identifier(&operation.session_id, "sessionId")?;
        super::session::validate_identifier(&operation.client_operation_id, "clientOperationId")?;
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "IMAGE_OPERATION_UNAVAILABLE")?;
        let key = (
            operation.session_id.clone(),
            operation.client_operation_id.clone(),
        );
        if !operations.contains_key(&key) && operations.len() >= 2048 {
            return Err("IMAGE_OPERATION_LIMIT: restart before importing more images".into());
        }
        Ok(operations.entry(key).or_default().clone())
    }
    pub(crate) fn cancel_session(&self, session: &str) -> Result<(), String> {
        for ((id, _), token) in self
            .operations
            .lock()
            .map_err(|_| "IMAGE_OPERATION_UNAVAILABLE")?
            .iter()
        {
            if id == session {
                token.cancel();
            }
        }
        Ok(())
    }
    pub(crate) fn import(
        &self,
        uploads: &[ImageUpload],
        token: &CancellationToken,
    ) -> Result<Vec<ImageRef>, String> {
        validate_upload_envelope(uploads)?;
        self.boundary("beforeNormalize", token)?;
        let prepared = uploads
            .iter()
            .map(|upload| normalize(upload, token))
            .collect::<Result<Vec<_>, _>>()?;
        self.boundary("normalized", token)?;
        let total_source_bytes: usize = uploads
            .iter()
            .map(|i| i.data.len() / 4 * 3 - i.data.bytes().rev().take_while(|b| *b == b'=').count())
            .sum();
        if total_source_bytes > VISION.max_batch_bytes {
            return Err("IMAGE_BATCH_LIMIT".into());
        }
        let root = self.root()?;
        for (reference, bytes) in &prepared {
            self.boundary("beforeWrite", token)?;
            let path = root.join(&reference.sha256);
            if path.exists() {
                self.read(reference)?;
                continue;
            }
            // Publish a fully fsynced temporary inode without ever overwriting an existing hash.
            let mut temp = tempfile::NamedTempFile::new_in(&root).map_err(image_error)?;
            temp.write_all(bytes).map_err(image_error)?;
            temp.as_file().sync_all().map_err(image_error)?;
            cancelled(token)?;
            match temp.persist_noclobber(&path) {
                Ok(file) => {
                    file.sync_all().map_err(image_error)?;
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.read(reference)?;
                }
                Err(error) => return Err(image_error(error.error)),
            }
            #[cfg(unix)]
            File::open(&root)
                .and_then(|file| file.sync_all())
                .map_err(image_error)?;
            self.read(reference)?;
            self.boundary("written", token)?;
        }
        cancelled(token)?;
        Ok(prepared
            .into_iter()
            .map(|(reference, _)| reference)
            .collect())
    }
    pub(crate) fn read(&self, reference: &ImageRef) -> Result<Vec<u8>, String> {
        reference.validate()?;
        let path = self.root()?.join(&reference.sha256);
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let file = options
            .open(&path)
            .map_err(|_| "IMAGE_BLOB_MISSING_OR_UNREADABLE")?;
        let metadata = file.metadata().map_err(image_error)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("IMAGE_REPARSE_POINT".into());
            }
        }
        if !metadata.is_file() || metadata.len() != reference.bytes {
            return Err("IMAGE_BLOB_TAMPERED".into());
        }
        let mut bytes = Vec::new();
        file.take(reference.bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(image_error)?;
        if bytes.len() as u64 != reference.bytes || digest(&bytes) != reference.sha256 {
            return Err("IMAGE_BLOB_TAMPERED".into());
        }
        let mut reader = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Png);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(reference.width);
        limits.max_image_height = Some(reference.height);
        limits.max_alloc = Some(VISION.max_decode_bytes);
        reader.limits(limits);
        let decoder = reader.into_decoder().map_err(image_error)?;
        if decoder.dimensions() != (reference.width, reference.height) {
            return Err("IMAGE_BLOB_FACTS_MISMATCH".into());
        }
        let image = DynamicImage::from_decoder(decoder).map_err(image_error)?;
        if image.width() != reference.width
            || image.height() != reference.height
            || image.color() != image::ColorType::Rgba8
        {
            return Err("IMAGE_BLOB_FACTS_MISMATCH".into());
        }
        Ok(bytes)
    }
    pub(crate) fn resolve_request(
        &self,
        provider: &AiProviderConfig,
        request: &mut ModelRequest,
        token: &CancellationToken,
    ) -> Result<(), String> {
        let refs = request
            .messages
            .iter()
            .flat_map(|m| match m {
                ModelMessage::UserImages { images, .. } => images.as_slice(),
                _ => &[],
            })
            .collect::<Vec<_>>();
        if refs.is_empty() {
            return Ok(());
        }
        let route = vision_route(provider)?;
        if refs.len() > route.max_request_images
            || refs.iter().map(|r| r.bytes).sum::<u64>() > route.max_request_image_bytes
        {
            return Err(
                "IMAGE_REQUEST_BUDGET: too many retained images; start a new session".into(),
            );
        }
        let mut resolved = BTreeMap::new();
        for reference in refs {
            cancelled(token)?;
            resolved.insert(
                reference.sha256.clone(),
                format!(
                    "data:image/png;base64,{}",
                    STANDARD.encode(self.read(reference)?)
                ),
            );
        }
        for message in &mut request.messages {
            if let ModelMessage::UserImages {
                images, data_urls, ..
            } = message
            {
                *data_urls = images.iter().map(|r| resolved[&r.sha256].clone()).collect();
            }
        }
        cancelled(token)
    }
}
