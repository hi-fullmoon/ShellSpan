#!/usr/bin/env python3
"""Regenerate the Windows icon set with the artwork filling the canvas.

The source artwork (src-tauri/icons/icon.png) is already full-bleed (see
the git history for the original padded version); this script crops the
opaque content just in case, re-centers it full-bleed, and box-downsamples
it into:

  - src-tauri/icons/icon.ico        (16,20,24,32,40,48,64,256 PNG entries)
  - src-tauri/icons/32x32.png
  - src-tauri/icons/64x64.png
  - src-tauri/icons/128x128.png
  - src-tauri/icons/128x128@2x.png

macOS assets (icon.icns) and Store tile logos are intentionally untouched:
they follow their own padding conventions.

Pure stdlib (zlib/struct) so it runs anywhere Python 3 does.

Usage: python scripts/regen-windows-icon.py
"""

import struct
import zlib
from pathlib import Path

ICONS_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SOURCE = ICONS_DIR / "icon.png"

# Fraction of the canvas the opaque artwork should occupy after cropping.
# 1.0 = full bleed: the rounded square touches the canvas edges (standard
# for Windows taskbar/tray icons; corners stay transparent due to the radius).
CONTENT_FILL = 1.0

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
PNG_TARGETS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
}


def decode_png(path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    pos = 8
    idat = b""
    width = height = None
    while pos < len(data):
        length, ctype = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bitdepth, colortype = struct.unpack(">IIBB", body[:10])
            if bitdepth != 8 or colortype != 6:
                raise ValueError(f"{path}: expected 8-bit RGBA PNG")
        elif ctype == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    channels = 4
    stride = width * channels
    rows = []
    prev = bytearray(stride)
    i = 0
    for _ in range(height):
        filter_type = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        if filter_type == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 255
        elif filter_type == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif filter_type == 3:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + (a + prev[x]) // 2) & 255
        elif filter_type == 4:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        elif filter_type != 0:
            raise ValueError(f"unsupported PNG filter {filter_type}")
        rows.append(line)
        prev = line
    return width, height, rows


def encode_png(width, height, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(ctype, body):
        return (
            struct.pack(">I", len(body))
            + ctype
            + body
            + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def content_bbox(width, height, rows, threshold=128):
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y, row in enumerate(rows):
        for x in range(width):
            if row[x * 4 + 3] > threshold:
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
    if max_x < 0:
        raise ValueError("source image is fully transparent")
    return min_x, min_y, max_x, max_y


def crop_square(width, height, rows, bbox, fill):
    """Crop to the content bbox, expanded to a square with `fill` headroom."""
    min_x, min_y, max_x, max_y = bbox
    cw = max_x - min_x + 1
    ch = max_y - min_y + 1
    side = max(cw, ch) / fill
    cx = (min_x + max_x + 1) / 2
    cy = (min_y + max_y + 1) / 2
    left = cx - side / 2
    top = cy - side / 2

    # Sample the (possibly fractional) crop window with bilinear interpolation.
    out_side = int(round(side))
    out = []
    for y in range(out_side):
        sy = top + (y + 0.5) * side / out_side - 0.5
        sy = min(max(sy, 0.0), height - 1.0)
        y0 = int(sy)
        y1 = min(y0 + 1, height - 1)
        fy = sy - y0
        row = bytearray(out_side * 4)
        for x in range(out_side):
            sx = left + (x + 0.5) * side / out_side - 0.5
            sx = min(max(sx, 0.0), width - 1.0)
            x0 = int(sx)
            x1 = min(x0 + 1, width - 1)
            fx = sx - x0
            for c in range(4):
                v00 = rows[y0][x0 * 4 + c]
                v10 = rows[y0][x1 * 4 + c]
                v01 = rows[y1][x0 * 4 + c]
                v11 = rows[y1][x1 * 4 + c]
                v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
                row[x * 4 + c] = int(round(v))
        out.append(row)
    return out_side, out


def downsample(src_side, src_rows, dst_side):
    """Area-average downsample from square src to dst_side x dst_side."""
    ratio = src_side / dst_side
    # Precompute per-axis coverage weights: for each dst pixel, the list of
    # (src_index, weight) pairs covering it.
    axis = []
    for d in range(dst_side):
        start = d * ratio
        end = start + ratio
        entries = []
        s = int(start)
        while s < end and s < src_side:
            w = min(end, s + 1) - max(start, s)
            entries.append((s, w))
            s += 1
        axis.append(entries)
    out = []
    for dy in range(dst_side):
        row = bytearray(dst_side * 4)
        y_entries = axis[dy]
        for dx in range(dst_side):
            acc = [0.0, 0.0, 0.0, 0.0]
            total = 0.0
            for sy, wy in y_entries:
                src_row = src_rows[sy]
                for sx, wx in axis[dx]:
                    w = wx * wy
                    total += w
                    base = sx * 4
                    for c in range(4):
                        acc[c] += src_row[base + c] * w
            for c in range(4):
                row[dx * 4 + c] = int(round(acc[c] / total))
        out.append(row)
    return out


def build_ico(png_by_size):
    entries = sorted(png_by_size)
    header = struct.pack("<HHH", 0, 1, len(entries))
    directory = b""
    offset = 6 + 16 * len(entries)
    blobs = b""
    for size in entries:
        blob = png_by_size[size]
        directory += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        blobs += blob
        offset += len(blob)
    return header + directory + blobs


def main():
    width, height, rows = decode_png(SOURCE)
    bbox = content_bbox(width, height, rows)
    cw = bbox[2] - bbox[0] + 1
    print(f"source {width}x{height}, content {cw}px ({cw / width:.0%} of canvas)")

    side, cropped = crop_square(width, height, rows, bbox, CONTENT_FILL)
    print(f"cropped to square side {side} (content fills {CONTENT_FILL:.0%})")

    png_by_size = {}
    for size in ICO_SIZES:
        resized = downsample(side, cropped, size)
        png_by_size[size] = encode_png(size, size, resized)
    (ICONS_DIR / "icon.ico").write_bytes(build_ico(png_by_size))
    print(f"wrote icon.ico with sizes {ICO_SIZES}")

    for name, size in PNG_TARGETS.items():
        resized = downsample(side, cropped, size)
        (ICONS_DIR / name).write_bytes(encode_png(size, size, resized))
        print(f"wrote {name}")


if __name__ == "__main__":
    main()
