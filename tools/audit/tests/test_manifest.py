import json

from . import helpers
from .helpers import TempDirTestCase

from auditlib.manifest import ManifestError, canonical_json, load_manifest, sha256_bytes


class CanonicalJsonTest(TempDirTestCase):
    def test_numbers_as_javascript_writes_them(self):
        cases = [
            (0, '0'),
            (-0.0, '0'),
            (2.0, '2'),
            (100.0, '100'),
            (12.5, '12.5'),
            (0.25, '0.25'),
            (0.000001, '0.000001'),
            (1e-7, '1e-7'),
            (1.5e-10, '1.5e-10'),
            (1e21, '1e+21'),
            (1e20, '100000000000000000000'),
            (-123.456, '-123.456'),
        ]
        for value, text in cases:
            with self.subTest(value=value):
                self.assertEqual(canonical_json(value), text)

    def test_keys_sorted_by_utf16_code_unit(self):
        # U+FFFF comes after the surrogate pair of U+1F600 in UTF-16, though not in code points.
        value = {'b': 1, 'a': [True, None], '\U0001f600': 'x', '￿': 'y'}
        self.assertEqual(canonical_json(value), '{"a":[true,null],"b":1,"\U0001f600":"x","￿":"y"}')

    def test_strings_keep_unicode_and_escape_controls(self):
        self.assertEqual(canonical_json('é\n"\\\x01'), '"é\\n\\"\\\\\\u0001"')


class DumpManifestTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('target')])

    def test_match(self):
        manifest = load_manifest(self.folder / 'manifest.json')
        self.assertEqual(manifest.tool, 'dump_nodes')
        self.assertEqual([e.local_path.name for e in manifest.entries], ['N17.json'])
        manifest.verify_all()
        data = manifest.read_verified(manifest.entries[0])
        self.assertEqual(json.loads(data), helpers.golden('target'))

    def test_mismatch_stops(self):
        path = self.folder / 'N17.json'
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b'#f4f6fa', b'#f4f6fb'))
        manifest = load_manifest(self.folder / 'manifest.json')
        with self.assertRaises(ManifestError) as caught:
            manifest.verify_all()
        self.assertIn('SHA-256', str(caught.exception))
        self.assertIn(sha256_bytes(raw), str(caught.exception))

    def test_size_mismatch_stops(self):
        path = self.folder / 'N17.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(ManifestError) as caught:
            load_manifest(self.folder / 'manifest.json').verify_all()
        self.assertIn('bytes', str(caught.exception))

    def test_missing_file_stops(self):
        (self.folder / 'N17.json').unlink()
        with self.assertRaises(ManifestError) as caught:
            load_manifest(self.folder / 'manifest.json').verify_all()
        self.assertIn('missing', str(caught.exception))

    def test_path_that_leaves_the_folder_is_refused(self):
        manifest_path = self.folder / 'manifest.json'
        data = json.loads(manifest_path.read_text(encoding='utf-8'))
        data['files'][0]['path'] = f'{helpers.OUTPUT_PATH}/../../outside.json'
        manifest_path.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaises(ManifestError) as caught:
            load_manifest(manifest_path)
        self.assertIn('plain relative path', str(caught.exception))

    def test_dump_manifest_must_be_named_manifest_json(self):
        renamed = self.folder / 'other.json'
        (self.folder / 'manifest.json').rename(renamed)
        with self.assertRaises(ManifestError):
            load_manifest(renamed)


class CaptureManifestTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.root = self.tmp / 'output-root'
        (self.root / 'captures').mkdir(parents=True)
        (self.root / 'more').mkdir()
        self.first = b'\x89PNG synthetic first'
        self.second = b'\x89PNG synthetic second'
        (self.root / 'captures' / 'a.png').write_bytes(self.first)
        (self.root / 'more' / 'b.png').write_bytes(self.second)
        self.name = 'save_screenshots-20260101T000000Z.manifest.json'
        self.manifest = {
            'tool': 'save_screenshots',
            'files': [
                {'kind': 'capture', 'index': 0, 'path': 'captures/a.png', 'sha256': sha256_bytes(self.first),
                 'bytes': len(self.first), 'ok': True},
                {'index': 1, 'nodeId': '1:2', 'ok': False, 'error': 'node not found'},
                {'kind': 'capture', 'index': 2, 'path': 'more/b.png', 'sha256': sha256_bytes(self.second),
                 'bytes': len(self.second), 'ok': True},
            ],
            'manifestPath': f'captures/{self.name}',
        }
        helpers.write_json(self.root / 'captures' / self.name, self.manifest)

    def test_paths_resolve_against_the_output_root(self):
        manifest = load_manifest(self.root / 'captures' / self.name)
        self.assertEqual(manifest.base, self.root.resolve())
        self.assertEqual([e.listed_path for e in manifest.entries], ['captures/a.png', 'more/b.png'])
        manifest.verify_all()

    def test_mismatch_stops(self):
        (self.root / 'more' / 'b.png').write_bytes(b'changed')
        with self.assertRaises(ManifestError):
            load_manifest(self.root / 'captures' / self.name).verify_all()

    def test_renamed_manifest_is_refused(self):
        moved = self.root / 'captures' / 'renamed.manifest.json'
        (self.root / 'captures' / self.name).rename(moved)
        with self.assertRaises(ManifestError) as caught:
            load_manifest(moved)
        self.assertIn('renamed or moved', str(caught.exception))


class JournalManifestTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.entries = helpers.make_entries(['create_frame', 'clear_paints'])
        self.folder = helpers.write_journal_folder(self.tmp / 'journal', self.entries)

    def test_match(self):
        manifest = load_manifest(self.folder / 'manifest.json')
        self.assertEqual(manifest.tool, 'dump_journal')
        entry = manifest.journal_entry()
        self.assertEqual(entry.local_path.name, 'journal.json')
        self.assertEqual(entry.listed_path, f'{helpers.JOURNAL_OUTPUT_PATH}/journal.json')
        data = json.loads(manifest.read_verified(entry))
        self.assertEqual(data['entries'], self.entries)

    def test_changed_byte_stops(self):
        path = self.folder / 'journal.json'
        path.write_bytes(path.read_bytes().replace(b'create_frame', b'create_fraMe'))
        manifest = load_manifest(self.folder / 'manifest.json')
        with self.assertRaises(ManifestError) as caught:
            manifest.read_verified(manifest.journal_entry())
        self.assertIn('SHA-256', str(caught.exception))

    def test_other_file_kind_is_refused(self):
        manifest_path = self.folder / 'manifest.json'
        data = json.loads(manifest_path.read_text(encoding='utf-8'))
        data['files'][0]['kind'] = 'nodes'
        manifest_path.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaises(ManifestError) as caught:
            load_manifest(manifest_path)
        self.assertIn('journal.json', str(caught.exception))

    def test_more_than_one_file_is_refused(self):
        manifest_path = self.folder / 'manifest.json'
        data = json.loads(manifest_path.read_text(encoding='utf-8'))
        data['files'].append(dict(data['files'][0]))
        manifest_path.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaises(ManifestError) as caught:
            load_manifest(manifest_path)
        self.assertIn('lists one file', str(caught.exception))

    def test_journal_entry_of_a_node_dump_is_refused(self):
        folder = helpers.write_dump_folder(self.tmp / 'nodes', [helpers.golden('target')])
        with self.assertRaises(ManifestError) as caught:
            load_manifest(folder / 'manifest.json').journal_entry()
        self.assertIn('dump_journal', str(caught.exception))
