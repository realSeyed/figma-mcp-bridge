import json
import shutil

from . import helpers
from .helpers import TempDirTestCase

import selfcheck
from auditlib.manifest import canonical_sha256, sha256_file

COPIED = [
    'variables.json',
    'exemptions.json',
    'config.json',
    'census_frame.baseline.json',
    'contrast_frame.baseline.json',
    'size_set.baseline.json',
    'components.json',
    'precheck_page.baseline.json',
]


class SelfcheckTest(TempDirTestCase):
    """A synthetic fixtures folder: the data files, one dump folder, and an expected.json."""

    def setUp(self):
        super().setUp()
        self.fixtures = self.tmp / 'fixtures'
        self.fixtures.mkdir()
        for name in COPIED:
            shutil.copy(helpers.DATA / name, self.fixtures / name)
        helpers.write_dump_folder(self.fixtures / 'dumps' / 'run1', [helpers.data('census_frame.dump.json')])
        self.outputs = self.tmp / 'outputs'
        census_inputs = {'variables': 'variables.json', 'exemptions': 'exemptions.json'}
        self.expected = {
            'config': 'config.json',
            'fingerprints': [
                {'name': 'baseline variables', 'path': 'variables.json',
                 'sha256': sha256_file(self.fixtures / 'variables.json')[:12]},
            ],
            'known_answers': [
                {
                    'name': 'census baseline frame',
                    'script': 'census',
                    'inputs': {'dump': 'census_frame.baseline.json', **census_inputs},
                    'figures': {
                        'unbound_paints.total': 4,
                        'unbound_paints.colours_all': {'#333333': 2, '#00ff00': 1, '#123456': 1},
                        'radius': {'bearing': 3, 'bound': 1, 'raw': 2},
                        'spacing.off_scale_values.24': 2,
                        'theme_or_raw_binding_entries_outside_exemptions': 2,
                    },
                },
                {
                    'name': 'census dumped frame',
                    'script': 'census',
                    'inputs': {'dump': 'dumps/run1', **census_inputs},
                    'figures': {'radius.raw': 2, 'hidden_content.nodes': 2},
                },
                {
                    'name': 'contrast pairs',
                    'script': 'contrast',
                    'inputs': {'dumps': ['contrast_frame.baseline.json'], 'variables': 'variables.json'},
                    'figures': {'pairs': {'20:3': {'ratio': '12.63', 'base': 'dump'}}},
                    'match': 'subset',
                },
                {
                    'name': 'contrast failing',
                    'script': 'contrast',
                    'inputs': {'dumps': ['contrast_frame.baseline.json'], 'variables': 'variables.json'},
                    'figure': 'active_dump.failing',
                    'expected': 2,
                },
                {
                    'name': 'set completeness',
                    'script': 'completeness',
                    'inputs': {'dump': 'size_set.baseline.json', 'components': 'components.json'},
                    'figure': 'set_completeness',
                    'expected': {'result': 'FAIL', 'carried': 2, 'expected': 3},
                    'match': 'subset',
                },
                {
                    'name': 'precheck all',
                    'script': 'sr_precheck',
                    'inputs': {'dump': 'precheck_page.baseline.json', 'mode': 'all'},
                    'figure': 'rows',
                    'expected': 5,
                },
            ],
        }

    def run_selfcheck(self, outputs=None):
        helpers.write_json(self.fixtures / 'expected.json', self.expected)
        return helpers.run_script('selfcheck.py', '--fixtures', self.fixtures, '--outputs', outputs or self.outputs)

    def test_pass(self):
        result = self.run_selfcheck()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = result.stdout.strip().split('\n')
        self.assertEqual(len(lines), 13)
        self.assertTrue(all(line.startswith('PASS ') for line in lines[:-1]), lines)
        self.assertEqual(lines[-1], 'SELFCHECK PASS checks=12')
        self.assertIn('PASS census baseline frame radius observed={"bearing": 3, "bound": 1, "raw": 2}', result.stdout)
        self.assertTrue(lines[0].startswith('PASS fingerprint baseline variables observed="'))
        written = (self.outputs / 'selfcheck.txt').read_text(encoding='utf-8')
        self.assertEqual(written, result.stdout.replace('\r\n', '\n'))
        self.assertTrue((self.outputs / 'selfcheck.json').is_file())

    def test_fail_on_a_mismatch(self):
        self.expected['known_answers'][3]['expected'] = 3
        self.expected['fingerprints'][0]['sha256'] = '0' * 12
        result = self.run_selfcheck()
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL contrast failing active_dump.failing observed=2 expected=3', result.stdout)
        self.assertIn('FAIL fingerprint baseline variables', result.stdout)
        self.assertTrue(result.stdout.strip().endswith('SELFCHECK FAIL checks=12 failed=2'))

    def test_a_missing_input_fails_with_code_2(self):
        (self.fixtures / 'size_set.baseline.json').unlink()
        result = self.run_selfcheck()
        self.assertEqual(result.returncode, 2)
        self.assertIn('FAIL set completeness set_completeness observed="error:', result.stdout)
        self.assertIn('the dump is missing', result.stdout)

    def test_a_missing_figure_fails(self):
        self.expected['known_answers'][3]['figure'] = 'active_dump.unknown'
        result = self.run_selfcheck()
        self.assertEqual(result.returncode, 2)
        self.assertIn('no such figure', result.stdout)

    def test_expected_json_without_known_answers_or_fingerprints(self):
        for broken, message in (
            ({'fingerprints': self.expected['fingerprints']}, 'no "known_answers" list'),
            ({'known_answers': self.expected['known_answers']}, 'no "fingerprints" list'),
            ({**self.expected, 'known_answers': {'census': {}}}, 'the form of the earlier scripts'),
        ):
            with self.subTest(message=message):
                self.expected = broken
                result = self.run_selfcheck()
                self.assertEqual(result.returncode, 2)
                written = json.loads((self.outputs / 'selfcheck.json').read_text(encoding='utf-8'))
                self.assertIn(message, written['results'][0]['observed'])
        (self.fixtures / 'expected.json').unlink()
        result = helpers.run_script('selfcheck.py', '--fixtures', self.fixtures, '--outputs', self.outputs)
        self.assertEqual(result.returncode, 2)
        self.assertIn('is missing', result.stdout)

    def test_outputs_inside_the_fixtures_are_refused(self):
        result = self.run_selfcheck(outputs=self.fixtures / 'outputs')
        self.assertEqual(result.returncode, 2)
        self.assertIn('fixtures folder', result.stderr)
        self.assertFalse((self.fixtures / 'outputs').exists())

    def test_canonical_fingerprint_and_a_short_prefix(self):
        variables = json.loads((self.fixtures / 'variables.json').read_text(encoding='utf-8'))
        self.expected['fingerprints'] = [
            {'name': 'canonical', 'path': 'variables.json', 'form': 'canonical', 'sha256': canonical_sha256(variables)},
            {'name': 'short', 'path': 'variables.json', 'sha256': sha256_file(self.fixtures / 'variables.json')[:7]},
        ]
        result = self.run_selfcheck()
        self.assertIn('PASS fingerprint canonical', result.stdout)
        self.assertIn('FAIL fingerprint short', result.stdout)
        self.assertIn('8 hexadecimal characters', result.stdout)
        self.assertEqual(result.returncode, 2)


class ComparisonTest(TempDirTestCase):
    def test_strict_equal_keeps_booleans_apart(self):
        self.assertTrue(selfcheck.strict_equal(1, 1.0))
        self.assertFalse(selfcheck.strict_equal(1, True))
        self.assertFalse(selfcheck.strict_equal({'a': 0}, {'a': False}))
        self.assertTrue(selfcheck.strict_equal({'a': [1, 'x']}, {'a': [1, 'x']}))

    def test_matches(self):
        self.assertTrue(selfcheck.matches(['b', 'a'], ['a', 'b'], 'unordered'))
        self.assertFalse(selfcheck.matches(['b', 'a'], ['a', 'b'], 'exact'))
        self.assertTrue(selfcheck.matches({'a': 1, 'b': {'c': 2, 'd': 3}}, {'b': {'c': 2}}, 'subset'))
        self.assertFalse(selfcheck.matches({'a': 1}, {'b': 1}, 'subset'))
        self.assertTrue(selfcheck.matches('abcdef0123', 'ABCDEF01', 'prefix'))
        self.assertFalse(selfcheck.matches('abcdef0123', 'abcdef0', 'prefix'))

    def test_figure_at_reads_keys_that_hold_a_dot(self):
        figures = {'spacing': {'off_scale_values': {'12.5': 1, '24': 2}}, 'pairs': {'1:2': {'ratio': '4.50'}}}
        self.assertEqual(selfcheck.figure_at(figures, 'spacing.off_scale_values.12.5'), 1)
        self.assertEqual(selfcheck.figure_at(figures, 'pairs.1:2.ratio'), '4.50')
        with self.assertRaises(KeyError):
            selfcheck.figure_at(figures, 'spacing.missing')
