use super::*;
use image::{ImageEncoder, Rgba};
use moxcms::ColorProfile;
use std::borrow::Cow;

fn profiled_upload(raster: &DynamicImage, format: ImageFormat, profile: Vec<u8>) -> ImageUpload {
    let mut bytes = Vec::new();
    match format {
        ImageFormat::Png => {
            let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
            encoder.set_icc_profile(profile).unwrap();
            raster.write_with_encoder(encoder).unwrap();
        }
        ImageFormat::Jpeg => {
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100);
            encoder.set_icc_profile(profile).unwrap();
            raster.write_with_encoder(encoder).unwrap();
        }
        ImageFormat::WebP => {
            let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut bytes);
            encoder.set_icc_profile(profile).unwrap();
            raster.write_with_encoder(encoder).unwrap();
        }
        _ => unreachable!(),
    }
    ImageUpload {
        media_type: format.to_mime_type().into(),
        data: STANDARD.encode(bytes),
        name: "profiled-image".into(),
    }
}

fn import(upload: ImageUpload) -> image::RgbaImage {
    let dir = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(dir.path()).unwrap();
    let refs = store.import(&[upload], &CancellationToken::new()).unwrap();
    let bytes = store.read(&refs[0]).unwrap();
    assert_eq!(refs[0].sha256, digest(&bytes));
    let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(&bytes)).unwrap();
    assert!(decoder.icc_profile().unwrap().is_none());
    assert!(decoder.exif_metadata().unwrap().is_none());
    DynamicImage::from_decoder(decoder).unwrap().to_rgba8()
}

fn assert_pixel(actual: &Rgba<u8>, expected: [u8; 4], tolerance: u8) {
    for (actual, expected) in actual.0.into_iter().zip(expected) {
        assert!(
            actual.abs_diff(expected) <= tolerance,
            "{actual} != {expected}"
        );
    }
}

#[test]
fn image_icc_srgb_png_jpeg_and_webp_are_accepted_and_metadata_removed() {
    let raster =
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 2, image::Rgb([128, 64, 32])));
    for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
        let result = import(profiled_upload(
            &raster,
            format,
            ColorProfile::new_srgb().encode().unwrap(),
        ));
        assert_eq!(result.dimensions(), (3, 2));
        assert_pixel(result.get_pixel(0, 0), [128, 64, 32, 255], 2);
    }
}

#[test]
fn image_icc_wide_gamut_pixels_are_converted_and_alpha_preserved() {
    let raster = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(3, 1, |x, _| {
        Rgba([128, 64, 32, [0, 117, 255][x as usize]])
    }));
    // Reference values from the D65 RGB primary matrices and their transfer functions.
    for (profile, expected) in [
        (ColorProfile::new_display_p3(), [138, 59, 21]),
        (ColorProfile::new_adobe_rgb(), [146, 62, 23]),
    ] {
        let result = import(profiled_upload(
            &raster,
            ImageFormat::Png,
            profile.encode().unwrap(),
        ));
        for (x, alpha) in [0, 117, 255].into_iter().enumerate() {
            let pixel = result.get_pixel(x as u32, 0);
            assert_pixel(pixel, [expected[0], expected[1], expected[2], alpha], 2);
            assert_eq!(pixel[3], alpha);
        }
    }
}

#[test]
fn image_icc_sixteen_bit_and_grayscale_convert_before_quantization() {
    let rgb = DynamicImage::ImageRgba16(image::ImageBuffer::from_pixel(
        2,
        1,
        Rgba([32896u16, 16448, 8224, 30069]),
    ));
    let result = import(profiled_upload(
        &rgb,
        ImageFormat::Png,
        ColorProfile::new_display_p3().encode().unwrap(),
    ));
    assert_pixel(result.get_pixel(0, 0), [138, 59, 21, 117], 2);
    assert_eq!(result.get_pixel(0, 0)[3], 117);
    for raster in [
        DynamicImage::ImageLumaA8(image::ImageBuffer::from_pixel(
            1,
            1,
            image::LumaA([128, 117]),
        )),
        DynamicImage::ImageLumaA16(image::ImageBuffer::from_pixel(
            1,
            1,
            image::LumaA([32896u16, 30069]),
        )),
    ] {
        let result = import(profiled_upload(
            &raster,
            ImageFormat::Png,
            ColorProfile::new_gray_with_gamma(1.0).encode().unwrap(),
        ));
        assert_pixel(result.get_pixel(0, 0), [188, 188, 188, 117], 1);
        assert_eq!(result.get_pixel(0, 0)[3], 117);
    }
}

fn png_upload(info: png::Info<'static>) -> ImageUpload {
    let mut bytes = Vec::new();
    let encoder = png::Encoder::with_info(&mut bytes, info).unwrap();
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&[128, 64, 32]).unwrap();
    writer.finish().unwrap();
    ImageUpload {
        media_type: "image/png".into(),
        data: STANDARD.encode(bytes),
        name: "png-metadata.png".into(),
    }
}

fn png_info() -> png::Info<'static> {
    let mut info = png::Info::default();
    info.width = 1;
    info.height = 1;
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = png::BitDepth::Eight;
    info
}

#[test]
fn image_icc_png_profile_overrides_legacy_gamma_and_chromaticity() {
    let mut info = png_info();
    info.icc_profile = Some(Cow::Owned(ColorProfile::new_display_p3().encode().unwrap()));
    info.source_gamma = Some(png::ScaledFloat::new(1.0));
    info.source_chromaticities = Some(png::SourceChromaticities::new(
        (0.3127, 0.3290),
        (0.68, 0.32),
        (0.265, 0.69),
        (0.15, 0.06),
    ));
    assert_pixel(
        import(png_upload(info)).get_pixel(0, 0),
        [138, 59, 21, 255],
        2,
    );
}

#[test]
fn image_icc_png_standard_srgb_metadata_is_accepted_without_icc() {
    for explicit_srgb in [false, true] {
        let mut info = png_info();
        info.source_gamma = Some(png::ScaledFloat::from_scaled(45455));
        info.source_chromaticities = Some(png::SourceChromaticities::new(
            (0.3127, 0.3290),
            (0.64, 0.33),
            (0.30, 0.60),
            (0.15, 0.06),
        ));
        if explicit_srgb {
            info.srgb = Some(png::SrgbRenderingIntent::Perceptual);
        }
        assert_pixel(
            import(png_upload(info)).get_pixel(0, 0),
            [128, 64, 32, 255],
            0,
        );
    }
}

#[test]
fn image_icc_invalid_and_mismatched_profiles_fail_without_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(dir.path()).unwrap();
    let raster =
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([128, 64, 32])));
    for profile in [
        vec![0; 128],
        ColorProfile::new_gray_with_gamma(2.2).encode().unwrap(),
    ] {
        let upload = profiled_upload(&raster, ImageFormat::Png, profile);
        assert!(store
            .import(&[upload], &CancellationToken::new())
            .unwrap_err()
            .contains("IMAGE_COLOR_PROFILE_UNSUPPORTED"));
    }
    let mut info = png_info();
    info.source_gamma = Some(png::ScaledFloat::new(1.0));
    assert!(store
        .import(&[png_upload(info)], &CancellationToken::new())
        .unwrap_err()
        .contains("IMAGE_COLOR_PROFILE_UNSUPPORTED"));
    assert_eq!(
        fs::read_dir(dir.path().join("agent-runtime/images-v1"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn image_icc_cancelled_conversion_does_not_return_pixels() {
    let token = CancellationToken::new();
    token.cancel();
    let raster = DynamicImage::ImageRgb8(image::RgbImage::new(2, 2));
    assert_eq!(
        color::to_srgb(raster, &ColorProfile::new_display_p3(), &token).unwrap_err(),
        "IMAGE_CANCELLED"
    );
}
