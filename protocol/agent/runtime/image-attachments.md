# Image attachment normalization

Image admission validates the shared `src/lib/ai/vision-contract.json` limits before decoding. PNG, JPEG, WebP and single-frame GIF inputs are normalized in the existing blocking import task; cancellation, batch atomicity and content-addressed storage remain unchanged.

Embedded RGB and grayscale ICC profiles are parsed and converted to sRGB with `moxcms` before resizing or stripping metadata. This includes sRGB, Display P3 and Adobe RGB profiles. Conversion preserves alpha, processes 16-bit samples before reducing them to 8 bits, and checks cancellation between scanlines. Profile parsing is bounded; invalid profiles and profiles inconsistent with the decoded pixel layout fail with `IMAGE_COLOR_PROFILE_UNSUPPORTED`.

For PNG, ICC or sRGB declarations take precedence over legacy gamma/chromaticity chunks. Standard sRGB gamma and chromaticity chunks are also accepted without ICC. Unprofiled RGB/grayscale images default to sRGB. Unsupported cICP declarations, non-sRGB gamma/chromaticity without ICC, and CMYK/YCCK JPEG inputs remain rejected rather than silently changing their colours.

EXIF orientation is applied. The stored representation remains a metadata-free RGBA8 PNG subject to the existing normalized dimension, pixel and byte limits. Durable events contain immutable verified image references only; the original image bytes and ICC metadata are never sent to the model.
