#!/usr/bin/env python3
"""tile.py — cuts a capture into overlapping tiles that are never scaled.

An image that is read at more than 1,568 pixels on the long edge is scaled
down, and small text is lost. The tiles are about 1,000 x 1,000 pixels, so a
tile is read at its own pixels.

The tile grid starts at the top left. A tile starts `tile size - overlap`
pixels after the one before it, on each axis, and the last tile on an axis ends
at the edge of the image. A tile at the edge is smaller than the tile size when
less than a tile is left; an image that is smaller than a tile gives one tile.

The reader and the writer handle 8-bit RGB and RGBA PNG files without
interlace, with `zlib` from the standard library. Any other PNG, and any other
format (a JPEG capture, for example), is refused with an error that names it.
The tiles keep the pixels exactly; the other chunks of the PNG file (colour
profile, gamma, text) are not copied.

When a capture manifest is given, the source is read through it: its size and
SHA-256 are checked first, and its pixel size is compared with the PNG header.

Exit codes: 0 when the tiles are written, 2 when an input is wrong. The tiles
and `<label>.tiles.json` go to the outputs folder. The tile manifest is not
named `manifest.json`, because a folder with that name is an evidence folder.
"""

import argparse
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.manifest import load_manifest, sha256_bytes  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402

PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
COLOR_TYPES = {2: ('RGB', 3), 6: ('RGBA', 4)}
COLOR_TYPE_NAMES = {0: 'greyscale', 2: 'RGB', 3: 'indexed colour', 4: 'greyscale with alpha', 6: 'RGBA'}
DEFAULT_TILE = 1000
DEFAULT_OVERLAP = 100


class PngError(cli.InputError):
    """A file is not a PNG that this reader handles."""


# ── PNG reader ───────────────────────────────────────────────────────


class Png:
    """A decoded PNG: its size, its colour type, and the pixel rows (`bytes`, no filter byte)."""

    def __init__(self, width, height, color_type, rows):
        self.width = width
        self.height = height
        self.color_type = color_type
        self.rows = rows

    @property
    def bytes_per_pixel(self):
        return COLOR_TYPES[self.color_type][1]


def _chunks(data, name):
    pos = len(PNG_SIGNATURE)
    while pos + 8 <= len(data):
        (length,) = struct.unpack('>I', data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        crc_bytes = data[pos + 8 + length : pos + 12 + length]
        if len(body) != length or len(crc_bytes) != 4:
            raise PngError(f'{name}: the PNG ends inside a {kind.decode("latin-1")} chunk.')
        (crc,) = struct.unpack('>I', crc_bytes)
        if zlib.crc32(kind + body) != crc:
            raise PngError(f'{name}: the {kind.decode("latin-1")} chunk has a wrong CRC; the file is damaged.')
        yield kind, body
        pos += 12 + length
        if kind == b'IEND':
            return
    raise PngError(f'{name}: the PNG has no IEND chunk; the file is cut.')


def read_png_header(data, name):
    """`(width, height, color_type)` from the IHDR of a PNG that this reader handles. Refuses the rest."""
    if data[:2] == b'\xff\xd8':
        raise PngError(f'{name}: this is a JPEG file. tile.py reads PNG captures only; capture with format PNG.')
    if data[:8] != PNG_SIGNATURE:
        raise PngError(f'{name}: this is not a PNG file. tile.py reads 8-bit RGB and RGBA PNG captures only.')
    if data[12:16] != b'IHDR' or len(data) < 33:
        raise PngError(f'{name}: the PNG has no IHDR chunk first.')
    width, height, depth, color_type, compression, filter_method, interlace = struct.unpack('>IIBBBBB', data[16:29])
    if depth != 8:
        raise PngError(f'{name}: the PNG has a bit depth of {depth}; tile.py reads 8-bit PNG files only.')
    if color_type not in COLOR_TYPES:
        kind = COLOR_TYPE_NAMES.get(color_type, f'colour type {color_type}')
        raise PngError(f'{name}: the PNG is {kind} (colour type {color_type}); tile.py reads RGB and RGBA only.')
    if interlace != 0:
        raise PngError(f'{name}: the PNG is interlaced (Adam7); tile.py reads PNG files without interlace only.')
    if compression != 0 or filter_method != 0:
        raise PngError(f'{name}: the PNG uses an unknown compression or filter method.')
    if width == 0 or height == 0:
        raise PngError(f'{name}: the PNG has no pixels.')
    return width, height, color_type


def read_png(data, name='the PNG'):
    width, height, color_type = read_png_header(data, name)
    bpp = COLOR_TYPES[color_type][1]
    stride = width * bpp
    idat = b''.join(body for kind, body in _chunks(data, name) if kind == b'IDAT')
    expected = height * (stride + 1)
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(idat, expected + 1)
    except zlib.error as err:
        raise PngError(f'{name}: the pixel data cannot be decompressed: {err}.') from None
    if len(raw) != expected:
        raise PngError(
            f'{name}: the pixel data has {len(raw)} bytes (or more), but a {width} x {height} image needs {expected}.'
        )
    return Png(width, height, color_type, _unfilter(raw, height, stride, bpp, name))


def _unfilter(raw, height, stride, bpp, name):
    rows = []
    previous = bytes(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1 : start + 1 + stride])
        if kind == 0:
            pass
        elif kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif kind == 2:
            line = bytearray((line[i] + previous[i]) & 255 for i in range(stride))
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = previous[i]
                c = previous[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + predictor) & 255
        else:
            raise PngError(f'{name}: row {y} uses the unknown filter type {kind}.')
        previous = bytes(line)
        rows.append(previous)
    return rows


# ── PNG writer ───────────────────────────────────────────────────────


def _chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


def write_png(width, height, color_type, rows):
    """A PNG file of 8-bit rows with filter type 0 on each row."""
    header = struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)
    raw = b''.join(b'\x00' + row for row in rows)
    return PNG_SIGNATURE + _chunk(b'IHDR', header) + _chunk(b'IDAT', zlib.compress(raw, 6)) + _chunk(b'IEND', b'')


# ── The grid ─────────────────────────────────────────────────────────


def grid(length, tile, overlap):
    """`(start, size)` along one axis."""
    step = tile - overlap
    spans = []
    start = 0
    while True:
        size = min(tile, length - start)
        spans.append((start, size))
        if start + tile >= length:
            return spans
        start += step


def cut(png, tile, overlap):
    """Each tile as `(row, column, x, y, width, height, png bytes)`, row by row."""
    bpp = png.bytes_per_pixel
    tiles = []
    for row, (y, height) in enumerate(grid(png.height, tile, overlap)):
        for column, (x, width) in enumerate(grid(png.width, tile, overlap)):
            lines = [line[x * bpp : (x + width) * bpp] for line in png.rows[y : y + height]]
            tiles.append((row, column, x, y, width, height, write_png(width, height, png.color_type, lines)))
    return tiles


# ── The command ──────────────────────────────────────────────────────


def read_source(path, manifest_path):
    """The bytes of the capture, checked against the capture manifest when one is given."""
    path = Path(path)
    if manifest_path is None:
        try:
            return path.read_bytes(), None
        except FileNotFoundError:
            raise cli.InputError(f'{path}: the capture is missing.') from None
    manifest = load_manifest(manifest_path)
    if manifest.tool != 'save_screenshots':
        raise cli.InputError(f'{manifest_path}: this is not the manifest of save_screenshots.')
    entry = manifest.entry_for(path)
    if entry is None:
        raise cli.InputError(f'{path}: the manifest {manifest_path} does not list this capture.')
    return manifest.read_verified(entry), entry


def main():
    parser = argparse.ArgumentParser(description='Cut a PNG capture into overlapping tiles')
    parser.add_argument('capture', help='The PNG capture')
    parser.add_argument('--manifest', default=None, help='The capture manifest of save_screenshots; the SHA-256 is checked')
    parser.add_argument('--tile-size', type=int, default=DEFAULT_TILE, help=f'The tile size in pixels (default {DEFAULT_TILE})')
    parser.add_argument('--overlap', type=int, default=DEFAULT_OVERLAP, help=f'The overlap in pixels (default {DEFAULT_OVERLAP})')
    parser.add_argument('--label', default=None, help='The name prefix of the output files')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    if args.tile_size < 1:
        raise cli.InputError('--tile-size must be 1 or more.')
    if not 0 <= args.overlap < args.tile_size:
        raise cli.InputError('--overlap must be 0 or more, and less than the tile size.')
    outputs = OutputDir(args.outputs, args.fixtures)
    data, entry = read_source(args.capture, args.manifest)
    png = read_png(data, str(args.capture))
    if entry is not None:
        for key, observed in (('pixelWidth', png.width), ('pixelHeight', png.height)):
            listed = entry.record.get(key)
            if isinstance(listed, int) and listed != observed:
                raise cli.InputError(f'{args.capture}: the manifest gives {key} {listed}, but the PNG header says {observed}.')

    label = args.label or Path(args.capture).stem
    records = []
    for row, column, x, y, width, height, tile_bytes in cut(png, args.tile_size, args.overlap):
        name = f'{label}.r{row:02d}c{column:02d}.png'
        outputs.path(name).write_bytes(tile_bytes)
        records.append(
            {
                'file': name,
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'bytes': len(tile_bytes),
                'sha256': sha256_bytes(tile_bytes),
            }
        )
    outputs.write_json(
        f'{label}.tiles.json',
        {
            'source': {
                'path': str(args.capture),
                'sha256': sha256_bytes(data),
                'bytes': len(data),
                'pixelWidth': png.width,
                'pixelHeight': png.height,
                'colorType': COLOR_TYPES[png.color_type][0],
                'checkedAgainst': str(args.manifest) if args.manifest else None,
            },
            'tileSize': args.tile_size,
            'overlap': args.overlap,
            'tiles': records,
        },
    )
    print(f'tile: {png.width} x {png.height} -> {len(records)} tiles of up to {args.tile_size} x {args.tile_size}')
    return cli.EXIT_OK


if __name__ == '__main__':
    cli.run(main)
