//! Colour management for admitted images. Keep metadata until the pixels are converted.
use image::{DynamicImage, RgbaImage};
use moxcms::{ColorProfile, DataColorSpace, Layout, ParsingOptions, TransformExecutor};
use std::io::Cursor;
use tokio_util::sync::CancellationToken;

use super::{cancelled, image_error, VISION};

pub(super) fn error(error: impl std::fmt::Display) -> String {
    format!("IMAGE_COLOR_PROFILE_UNSUPPORTED: {error}")
}

pub(super) fn parse(bytes: &[u8]) -> Result<ColorProfile, String> {
    ColorProfile::new_from_slice_with_options(
        bytes,
        ParsingOptions {
            max_profile_size: VISION.max_source_bytes,
            ..Default::default()
        },
    )
    .map_err(error)
}

pub(super) fn validate_png(bytes: &[u8], has_icc: bool) -> Result<(), String> {
    let decoder = png::Decoder::new_with_limits(
        Cursor::new(bytes),
        png::Limits {
            bytes: VISION.max_decode_bytes as usize,
        },
    );
    let reader = decoder.read_info().map_err(image_error)?;
    let info = reader.info();
    // cICP takes precedence over ICC. Do not silently discard unsupported HDR/video semantics.
    if info.coding_independent_code_points.is_some() {
        return Err(error("unsupported PNG cICP declaration"));
    }
    // ICC and sRGB declarations override the legacy gAMA/cHRM fallback chunks.
    if has_icc || info.srgb.is_some() {
        return Ok(());
    }
    let srgb_primaries = png::SourceChromaticities::new(
        (0.3127, 0.3290),
        (0.6400, 0.3300),
        (0.3000, 0.6000),
        (0.1500, 0.0600),
    );
    if info.gama_chunk.is_some_and(|v| v.into_scaled() != 45455)
        || info.chrm_chunk.is_some_and(|v| v != srgb_primaries)
    {
        return Err(error("PNG requires an ICC profile for this colour space"));
    }
    Ok(())
}

pub(super) fn to_srgb(
    raster: DynamicImage,
    profile: &ColorProfile,
    token: &CancellationToken,
) -> Result<DynamicImage, String> {
    cancelled(token)?;
    let layout = match raster.color() {
        image::ColorType::L8 | image::ColorType::L16 => Layout::Gray,
        image::ColorType::La8 | image::ColorType::La16 => Layout::GrayAlpha,
        image::ColorType::Rgb8 | image::ColorType::Rgb16 => Layout::Rgb,
        image::ColorType::Rgba8 | image::ColorType::Rgba16 => Layout::Rgba,
        _ => return Err(error("unsupported pixel layout")),
    };
    let expected = if matches!(layout, Layout::Gray | Layout::GrayAlpha) {
        DataColorSpace::Gray
    } else {
        DataColorSpace::Rgb
    };
    if profile.color_space != expected {
        return Err(error("ICC colour space does not match decoded pixels"));
    }
    let destination = ColorProfile::new_srgb();
    let dimensions = (raster.width(), raster.height());
    let channels = raster.color().channel_count() as usize;
    let output = if raster.color().bits_per_pixel() / channels as u16 == 16 {
        let transform = profile
            .create_transform_16bit(layout, &destination, Layout::Rgba, Default::default())
            .map_err(error)?;
        let samples = match &raster {
            DynamicImage::ImageLuma16(v) => v.as_raw(),
            DynamicImage::ImageLumaA16(v) => v.as_raw(),
            DynamicImage::ImageRgb16(v) => v.as_raw(),
            DynamicImage::ImageRgba16(v) => v.as_raw(),
            _ => unreachable!("16-bit layout checked above"),
        };
        convert_rows(samples, dimensions, channels, &*transform, token, |v| {
            ((u32::from(v) + 128) / 257) as u8
        })?
    } else {
        let transform = profile
            .create_transform_8bit(layout, &destination, Layout::Rgba, Default::default())
            .map_err(error)?;
        convert_rows(
            raster.as_bytes(),
            dimensions,
            channels,
            &*transform,
            token,
            |v| v,
        )?
    };
    Ok(DynamicImage::ImageRgba8(output))
}

fn convert_rows<T: Copy + Default>(
    samples: &[T],
    (width, height): (u32, u32),
    channels: usize,
    transform: &dyn TransformExecutor<T>,
    token: &CancellationToken,
    to_byte: impl Fn(T) -> u8,
) -> Result<RgbaImage, String> {
    let mut output = RgbaImage::new(width, height);
    // Only one temporary scanline, including for 16-bit input; retain cancellation responsiveness.
    let mut row = vec![T::default(); width as usize * 4];
    for (source, target) in samples
        .chunks_exact(width as usize * channels)
        .zip(output.chunks_exact_mut(width as usize * 4))
    {
        cancelled(token)?;
        transform.transform(source, &mut row).map_err(error)?;
        for (sample, byte) in row.iter().zip(target.iter_mut()) {
            *byte = to_byte(*sample);
        }
    }
    Ok(output)
}
