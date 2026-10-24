import json
import struct
import zlib

from . import helpers
from .helpers import TempDirTestCase

import tile
from auditlib.manifest import sha256_bytes

SIGNATURE = b'\x89PNG\r\n\x1a\n'


def pixel(x, y, bpp):
    """A synthetic pixel that differs from its neighbours."""
    base = ((x * 7 + y) % 256, (x + y * 3) % 256, (x * y) % 256)
    return bytes(base + (((x + y) % 251,) if bpp == 4 else ()))


def raw_rows(width, height, bpp):
    return [b''.join(pixel(x, y, bpp) for x in range(width)) for y in range(height)]


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def apply_filter(kind, row, previous, bpp):
    out = bytearray()
    for i, value in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = previous[i]
        c = previous[i - bpp] if i >= bpp else 0
        predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][kind]
        out.append((value - predictor) & 255)
    return bytes(out)


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


def make_png(width, height, color_type=2, filters=(0, 1, 2, 3, 4), depth=8, interlace=0):
    """A PNG written by the test: each row gets the next filter type of `filters`."""
    bpp = 4 if color_type == 6 else 3
    rows = raw_rows(width, height, bpp)
    previous = bytes(width * bpp)
    data = b''
    for y, row in enumerate(rows):
        kind = filters[y % len(filters)]
        data += bytes([kind]) + apply_filter(kind, row, previous, bpp)
        previous = row
    header = struct.pack('>IIBBBBB', width, height, depth, color_type, 0, 0, interlace)
    return SIGNATURE + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b'')


class ReaderTest(TempDirTestCase):
    def test_each_filter_type_and_both_colour_types_decode(self):
        for color_type, bpp in [(2, 3), (6, 4)]:
            for filters in [(0,), (1,), (2,), (3,), (4,), (0, 1, 2, 3, 4)]:
                with self.subTest(color_type=color_type, filters=filters):
                    png = tile.read_png(make_png(13, 11, color_type, filters))
                    self.assertEqual((png.width, png.height, png.color_type), (13, 11, color_type))
                    self.assertEqual(png.rows, raw_rows(13, 11, bpp))

    def test_the_writer_round_trips(self):
        rows = raw_rows(9, 5, 4)
        again = tile.read_png(tile.write_png(9, 5, 6, rows))
        self.assertEqual(again.rows, rows)

    def test_refusals_name_the_reason(self):
        cases = {
            'interlaced': (make_png(4, 4, interlace=1), 'interlaced'),
            '16-bit': (make_png(4, 4, depth=16), 'bit depth of 16'),
            'indexed': (make_png(4, 4, color_type=3), 'indexed colour'),
            'greyscale': (make_png(4, 4, color_type=0), 'greyscale'),
            'jpeg': (b'\xff\xd8\xff\xe0 synthetic jpeg', 'JPEG'),
            'not a png': (b'GIF89a synthetic', 'not a PNG'),
            'empty': (b'', 'not a PNG'),
        }
        for label, (data, words) in cases.items():
            with self.subTest(label):
                with self.assertRaises(tile.PngError) as caught:
                    tile.read_png(data, 'x.png')
                self.assertIn(words, str(caught.exception))

    def test_damaged_files_are_refused(self):
        good = make_png(8, 8)
        damaged = good[:40] + bytes([good[40] ^ 1]) + good[41:]
        for label, data in {'crc': damaged, 'cut': good[:-12], 'short data': make_png(8, 8)[:30]}.items():
            with self.subTest(label):
                with self.assertRaises(tile.PngError):
                    tile.read_png(data, 'x.png')

    def test_pixel_data_of_the_wrong_size_is_refused(self):
        header = struct.pack('>IIBBBBB', 4, 4, 8, 2, 0, 0, 0)
        data = SIGNATURE + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(b'\x00' * 10)) + chunk(b'IEND', b'')
        with self.assertRaises(tile.PngError) as caught:
            tile.read_png(data, 'x.png')
        self.assertIn('needs 52', str(caught.exception))


class GridTest(TempDirTestCase):
    def test_grid_spans(self):
        self.assertEqual(tile.grid(30, 100, 10), [(0, 30)])
        self.assertEqual(tile.grid(100, 100, 10), [(0, 100)])
        self.assertEqual(tile.grid(190, 100, 10), [(0, 100), (90, 100)])
        self.assertEqual(tile.grid(191, 100, 10), [(0, 100), (90, 100), (180, 11)])
        self.assertEqual(tile.grid(2500, 1000, 100), [(0, 1000), (900, 1000), (1800, 700)])
        self.assertEqual(tile.grid(5, 1, 0), [(i, 1) for i in range(5)])

    def test_every_pixel_is_covered(self):
        for length in range(1, 60):
            covered = set()
            for start, size in tile.grid(length, 17, 5):
                covered.update(range(start, start + size))
            self.assertEqual(covered, set(range(length)), length)


class CutTest(TempDirTestCase):
    def check_tiles(self, png, tiles, bpp):
        for row, column, x, y, width, height, data in tiles:
            decoded = tile.read_png(data)
            self.assertEqual((decoded.width, decoded.height), (width, height))
            expected = [b''.join(pixel(x + i, y + j, bpp) for i in range(width)) for j in range(height)]
            self.assertEqual(decoded.rows, expected, (row, column))

    def test_an_image_smaller_than_one_tile(self):
        png = tile.read_png(make_png(30, 20))
        tiles = tile.cut(png, 100, 10)
        self.assertEqual([(t[2], t[3], t[4], t[5]) for t in tiles], [(0, 0, 30, 20)])
        self.check_tiles(png, tiles, 3)

    def test_an_image_of_exactly_two_tiles(self):
        png = tile.read_png(make_png(190, 100, 6))
        tiles = tile.cut(png, 100, 10)
        self.assertEqual([(t[2], t[3], t[4], t[5]) for t in tiles], [(0, 0, 100, 100), (90, 0, 100, 100)])
        self.check_tiles(png, tiles, 4)

    def test_edge_tiles_are_smaller_and_the_overlap_is_shared(self):
        png = tile.read_png(make_png(250, 120))
        tiles = tile.cut(png, 100, 20)
        boxes = [(t[2], t[3], t[4], t[5]) for t in tiles]
        self.assertEqual(
            boxes,
            [(0, 0, 100, 100), (80, 0, 100, 100), (160, 0, 90, 100),
             (0, 80, 100, 40), (80, 80, 100, 40), (160, 80, 90, 40)],
        )
        self.check_tiles(png, tiles, 3)
        first, second = tile.read_png(tiles[0][6]), tile.read_png(tiles[1][6])
        # The last 20 columns of the first tile are the first 20 of the second.
        self.assertEqual([r[80 * 3 :] for r in first.rows], [r[: 20 * 3] for r in second.rows])

    def test_a_tile_is_never_scaled(self):
        png = tile.read_png(make_png(70, 40))
        for _r, _c, _x, _y, width, height, data in tile.cut(png, 32, 4):
            self.assertLessEqual(width, 32)
            self.assertLessEqual(height, 32)
            decoded = tile.read_png(data)
            self.assertEqual((decoded.width, decoded.height), (width, height))


class CommandTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.capture = self.tmp / 'root' / 'captures' / 'frame.png'
        self.capture.parent.mkdir(parents=True)
        self.png = make_png(250, 120)
        self.capture.write_bytes(self.png)
        self.outputs = self.tmp / 'out'

    def write_manifest(self, **overrides):
        entry = {
            'kind': 'capture',
            'index': 0,
            'path': 'captures/frame.png',
            'sha256': sha256_bytes(self.png),
            'bytes': len(self.png),
            'format': 'PNG',
            'scale': 1,
            'pixelWidth': 250,
            'pixelHeight': 120,
            'ok': True,
        }
        entry.update(overrides)
        name = 'save_screenshots-20260101T000000Z.manifest.json'
        return helpers.write_json(
            self.capture.parent / name,
            {'tool': 'save_screenshots', 'files': [entry], 'manifestPath': f'captures/{name}'},
        )

    def run_tile(self, *extra):
        return helpers.run_script('tile.py', self.capture, '--outputs', self.outputs, *extra)

    def test_writes_the_tiles_and_the_tile_manifest(self):
        done = self.run_tile('--tile-size', '100', '--overlap', '20')
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads((self.outputs / 'frame.tiles.json').read_text(encoding='utf-8'))
        self.assertEqual(report['source']['sha256'], sha256_bytes(self.png))
        self.assertEqual((report['source']['pixelWidth'], report['source']['pixelHeight']), (250, 120))
        self.assertEqual(report['source']['colorType'], 'RGB')
        self.assertEqual(len(report['tiles']), 6)
        for entry in report['tiles']:
            data = (self.outputs / entry['file']).read_bytes()
            self.assertEqual(sha256_bytes(data), entry['sha256'])
            self.assertEqual(len(data), entry['bytes'])
        self.assertEqual(report['tiles'][1]['file'], 'frame.r00c01.png')
        self.assertEqual({p.name for p in self.outputs.iterdir()}, {'frame.tiles.json', *[t['file'] for t in report['tiles']]})
        self.assertEqual(self.capture.read_bytes(), self.png)

    def test_the_defaults_are_1000_and_100(self):
        self.assertEqual(self.run_tile().returncode, 0)
        report = json.loads((self.outputs / 'frame.tiles.json').read_text(encoding='utf-8'))
        self.assertEqual((report['tileSize'], report['overlap'], len(report['tiles'])), (1000, 100, 1))

    def test_a_matching_capture_manifest_passes(self):
        manifest = self.write_manifest()
        done = self.run_tile('--manifest', manifest)
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads((self.outputs / 'frame.tiles.json').read_text(encoding='utf-8'))
        self.assertEqual(report['source']['checkedAgainst'], str(manifest))

    def test_a_capture_that_changed_after_the_manifest_is_refused(self):
        manifest = self.write_manifest()
        changed = bytearray(self.png)
        changed[50] ^= 1
        self.capture.write_bytes(bytes(changed))
        done = self.run_tile('--manifest', manifest)
        self.assertEqual(done.returncode, 2)
        self.assertIn('SHA-256', done.stderr)
        self.assertFalse(self.outputs.exists() and any(self.outputs.iterdir()))

    def test_a_manifest_that_does_not_list_the_capture_is_refused(self):
        manifest = self.write_manifest(path='captures/other.png')
        (self.capture.parent / 'other.png').write_bytes(self.png)
        done = self.run_tile('--manifest', manifest)
        self.assertEqual(done.returncode, 2)
        self.assertIn('does not list', done.stderr)

    def test_a_pixel_size_that_the_manifest_contradicts_is_refused(self):
        done = self.run_tile('--manifest', self.write_manifest(pixelWidth=251))
        self.assertEqual(done.returncode, 2)
        self.assertIn('pixelWidth', done.stderr)

    def test_a_dump_manifest_is_not_a_capture_manifest(self):
        folder = helpers.write_dump_folder(self.tmp / 'dump', [helpers.data('size_set.dump.json')])
        done = self.run_tile('--manifest', folder / 'manifest.json')
        self.assertEqual(done.returncode, 2)

    def test_unusable_pngs_exit_with_2(self):
        for label, data in {
            'interlaced': make_png(8, 8, interlace=1),
            'sixteen bit': make_png(8, 8, depth=16),
            'jpeg': b'\xff\xd8\xff\xe0 synthetic',
        }.items():
            with self.subTest(label):
                self.capture.write_bytes(data)
                done = self.run_tile()
                self.assertEqual(done.returncode, 2)
                self.assertTrue(done.stderr.startswith('error: '))
                self.assertFalse(self.outputs.exists() and any(self.outputs.iterdir()))

    def test_a_missing_capture_and_bad_options_exit_with_2(self):
        self.capture.unlink()
        self.assertEqual(self.run_tile().returncode, 2)
        self.capture.write_bytes(self.png)
        for options in [('--tile-size', '0'), ('--overlap', '-1'), ('--tile-size', '50', '--overlap', '50')]:
            with self.subTest(options):
                self.assertEqual(self.run_tile(*options).returncode, 2)

    def test_the_outputs_may_not_go_into_the_evidence_folder(self):
        self.write_manifest()
        done = helpers.run_script('tile.py', self.capture, '--outputs', self.capture.parent / 'tiles')
        self.assertEqual(done.returncode, 2)
        self.assertEqual(sorted(p.name for p in self.capture.parent.iterdir())[0], 'frame.png')
        self.assertFalse((self.capture.parent / 'tiles').exists())

    def test_the_tile_manifest_does_not_make_the_outputs_an_evidence_folder(self):
        self.assertEqual(self.run_tile().returncode, 0)
        self.assertEqual(self.run_tile().returncode, 0)
