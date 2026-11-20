# Image attachment normalization

Image admission validates the shared `src/lib/ai/vision-contract.json` limits before decoding. PNG, JPEG, WebP and single-frame GIF inputs are normalized in a blocking task. Draft preparation returns normalized bytes in memory. Admission and queue edits write content-addressed blobs before publishing their durable Inbox references.

Blob writes and reference cleanup share a lock. Failed or cancelled admissions
and edits reclaim unreferenced blobs. App startup reclaims abandoned blobs from
interrupted or older preparations. Removing an archived session reclaims a
blob only when no remaining active or archived session references it.

Completed and rejected submissions release their in-flight operation records.
The durable Inbox receipt still acknowledges retries. Explicit cancellation
also retains a five-minute marker for delayed requests that have yet to arrive.
An already active operation keeps its cancelled token until its last caller exits.

Before committing a new image submission or a queue edit that adds images, the
runtime checks the model's image count and normalized byte limits against the
retained conversation and queued messages. A replacement counts the updated
attachments once. Request preparation uses the same image limits.

Embedded RGB and grayscale ICC profiles are parsed and converted to sRGB with `moxcms` before resizing or stripping metadata. This includes sRGB, Display P3 and Adobe RGB profiles. Conversion preserves alpha, processes 16-bit samples before reducing them to 8 bits, and checks cancellation between scanlines. Profile parsing is bounded; invalid profiles and profiles inconsistent with the decoded pixel layout fail with `IMAGE_COLOR_PROFILE_UNSUPPORTED`.

For PNG, a streaming parser checks every chunk through IEND without decompressing the pixels again. Invalid, duplicate or misplaced colour declarations are rejected, including ancillary-chunk errors that the high-level decoder would otherwise ignore. These checks apply even when an ICC or sRGB declaration is present. Valid ICC or sRGB declarations take precedence over legacy gamma/chromaticity chunks. Standard sRGB gamma and chromaticity chunks are also accepted without ICC. Unprofiled RGB/grayscale images default to sRGB. Unsupported cICP declarations, non-sRGB gamma/chromaticity without ICC, and CMYK/YCCK JPEG inputs remain rejected rather than silently changing their colours.

EXIF orientation is applied. The stored representation remains a metadata-free RGBA8 PNG subject to the existing normalized dimension, pixel and byte limits. Durable events contain immutable verified image references only; the original image bytes and ICC metadata are never sent to the model.
