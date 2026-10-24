import os

from . import helpers
from .helpers import TempDirTestCase

from auditlib.outputs import OutputDir, OutputError


class OutputDirTest(TempDirTestCase):
    def test_a_new_folder_is_made_and_written(self):
        outputs = OutputDir(self.tmp / 'outputs' / 'run1')
        self.assertTrue(outputs.root.is_dir())
        path = outputs.write_json('a.json', {'b': 1})
        self.assertEqual(path.read_text(encoding='utf-8'), '{\n  "b": 1\n}\n')
        path = outputs.write_csv('sub/rows.csv', ['x', 'y'], [{'x': 1, 'y': 'é'}])
        self.assertEqual(path.read_bytes(), 'x,y\n1,é\n'.encode('utf-8'))

    def test_an_evidence_folder_is_refused(self):
        folder = helpers.write_dump_folder(self.tmp / 'dump', [helpers.golden('target')])
        for target in (folder, folder / 'below', folder / 'below' / 'deeper'):
            with self.subTest(target=target):
                with self.assertRaises(OutputError) as caught:
                    OutputDir(target)
                self.assertIn('evidence folder', str(caught.exception))
        self.assertFalse((folder / 'below').exists())

    def test_a_capture_folder_is_refused(self):
        captures = self.tmp / 'captures'
        captures.mkdir()
        (captures / 'save_screenshots-20260101T000000Z.manifest.json').write_text('{}', encoding='utf-8')
        with self.assertRaises(OutputError):
            OutputDir(captures / 'outputs')

    def test_the_fixtures_folder_is_refused(self):
        fixtures = self.tmp / 'fixtures'
        fixtures.mkdir()
        with self.assertRaises(OutputError) as caught:
            OutputDir(fixtures / 'outputs', fixtures=fixtures)
        self.assertIn('fixtures folder', str(caught.exception))
        # A folder that holds expected.json is a fixtures folder without being named.
        (fixtures / 'expected.json').write_text('{}', encoding='utf-8')
        with self.assertRaises(OutputError):
            OutputDir(fixtures)
        self.assertFalse((fixtures / 'outputs').exists())

    def test_a_name_that_leaves_the_folder_is_refused(self):
        outputs = OutputDir(self.tmp / 'outputs')
        names = ['../escape.txt', str(self.tmp / 'abs.txt'), '']
        if os.name == 'nt':
            names.append('C:relative.txt')
        for name in names:
            with self.subTest(name=name):
                with self.assertRaises(OutputError):
                    outputs.write_text(name, 'x')
        self.assertFalse((self.tmp / 'escape.txt').exists())

    def test_an_evidence_folder_inside_the_outputs_is_refused(self):
        outputs = OutputDir(self.tmp / 'outputs')
        helpers.write_dump_folder(outputs.root / 'copied-dump', [helpers.golden('target')])
        with self.assertRaises(OutputError):
            outputs.write_text('copied-dump/notes.txt', 'x')

    def test_no_folder_is_refused(self):
        with self.assertRaises(OutputError):
            OutputDir('')
