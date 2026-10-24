import importlib
import json

from . import helpers
from .helpers import TempDirTestCase

importlib.import_module('assert')

CENSUS = 'census_frame.dump.json'
GOOD = {'id': 'g', 'node': '10:1', 'field': 'name', 'op': 'eq', 'expected': 'synthetic/frame'}

# The operator rows, worked out by hand from census_frame: 10:1 is a 400 x 300 frame named synthetic/frame;
# 10:11 is a hidden frame, so its styles.visible is false.
OPERATOR_ROWS = [
    ('eq-pass', '10:1', 'name', 'eq', 'synthetic/frame', 'PASS'),
    ('eq-fail', '10:1', 'name', 'eq', 'other', 'FAIL'),
    ('eq-bool', '10:11', 'styles.visible', 'eq', False, 'PASS'),
    ('eq-bool-is-not-zero', '10:11', 'styles.visible', 'eq', 0, 'FAIL'),
    ('ne-pass', '10:1', 'name', 'ne', 'other', 'PASS'),
    ('ne-fail', '10:1', 'name', 'ne', 'synthetic/frame', 'FAIL'),
    ('lt-pass', '10:1', 'bounds.width', 'lt', 1000, 'PASS'),
    ('lt-fail', '10:1', 'bounds.width', 'lt', 400, 'FAIL'),
    ('le-pass', '10:1', 'bounds.width', 'le', 400, 'PASS'),
    ('le-fail', '10:1', 'bounds.width', 'le', 399, 'FAIL'),
    ('gt-pass', '10:1', 'bounds.width', 'gt', 399, 'PASS'),
    ('gt-fail', '10:1', 'bounds.width', 'gt', 400, 'FAIL'),
    ('ge-pass', '10:1', 'bounds.width', 'ge', 400, 'PASS'),
    ('ge-fail', '10:1', 'bounds.width', 'ge', 401, 'FAIL'),
    ('approx-pass', '10:1', 'bounds.width', 'approx', 400.4, 'PASS'),
    ('approx-fail', '10:1', 'bounds.width', 'approx', 401, 'FAIL'),
    ('in-pass', '10:1', 'type', 'in', ['TEXT', 'FRAME'], 'PASS'),
    ('in-fail', '10:1', 'type', 'in', ['TEXT'], 'FAIL'),
    ('contains-str-pass', '10:1', 'name', 'contains', 'thetic/fr', 'PASS'),
    ('contains-list-pass', '10:1', 'boundVariables.fills', 'contains', 'VariableID:91:3', 'PASS'),
    ('contains-dict-pass', '10:1', 'boundVariables', 'contains', 'paddingTop', 'PASS'),
    ('contains-fail', '10:1', 'name', 'contains', 'zzz', 'FAIL'),
    ('matches-pass', '10:1', 'name', 'matches', r'^synthetic/f\w+$', 'PASS'),
    ('matches-fail', '10:1', 'name', 'matches', r'^\d+$', 'FAIL'),
    ('exists-pass', '10:1', 'styles.fills[0].color', 'exists', None, 'PASS'),
    ('exists-fail', '10:1', 'styles.nope', 'exists', None, 'FAIL'),
    ('absent-pass', '10:1', 'styles.nope', 'absent', None, 'PASS'),
    ('absent-fail', '10:1', 'name', 'absent', None, 'FAIL'),
    ('missing-fails-ne', '10:1', 'styles.nope', 'ne', 'x', 'FAIL'),
    ('missing-fails-lt', '10:1', 'styles.nope', 'lt', 5, 'FAIL'),
    ('text-fails-lt', '10:1', 'name', 'lt', 5, 'FAIL'),
]


class AssertTest(TempDirTestCase):
    def run_checks(self, rows, dump=None, *extra):
        checks = helpers.write_json(self.tmp / 'checks.json', rows)
        if dump is None:
            dump = self.tmp / 'run'
            if not dump.exists():
                helpers.write_dump_folder(dump, [helpers.data(CENSUS)])
        return helpers.run_script('assert.py', checks, dump, '--outputs', self.tmp / 'out', *extra)

    def report(self):
        return json.loads((self.tmp / 'out' / 'checks.assert.json').read_text(encoding='utf-8'))

    def results(self, rows, dump=None, *extra):
        done = self.run_checks(rows, dump, *extra)
        self.assertIn(done.returncode, (0, 1), done.stderr)
        return {r['id']: r['result'] for r in self.report()['results']}

    def test_each_operator_passes_and_fails(self):
        checks = []
        for id_, node, field, op, expected, _want in OPERATOR_ROWS:
            row = {'id': id_, 'node': node, 'field': field, 'op': op}
            if op not in ('exists', 'absent'):
                row['expected'] = expected
            if op == 'approx':
                row['tolerance'] = 0.5
            checks.append(row)
        self.assertEqual(self.results(checks), {row[0]: row[5] for row in OPERATOR_ROWS})

    def test_measures(self):
        checks = [
            {'id': 'children', 'node': '10:1', 'measure': 'childCount', 'op': 'eq', 'expected': 6},
            {'id': 'visible-children', 'node': '10:1', 'measure': 'visibleChildCount', 'op': 'eq', 'expected': 5},
            {'id': 'bound-scalar', 'node': '10:1', 'measure': 'boundVariable(paddingTop)', 'op': 'eq', 'expected': 'VariableID:90:3'},
            {'id': 'bound-index', 'node': '10:1', 'measure': 'boundVariable(fills[0])', 'op': 'eq', 'expected': 'VariableID:91:3'},
            {'id': 'bound-list', 'node': '10:1', 'measure': 'boundVariable(fills)', 'op': 'eq', 'expected': ['VariableID:91:3']},
            {'id': 'unbound', 'node': '10:5', 'measure': 'boundVariable(fills)', 'op': 'absent'},
            {'id': 'wrong-binding', 'node': '10:1', 'measure': 'boundVariable(paddingTop)', 'op': 'eq', 'expected': 'VariableID:1:1'},
        ]
        results = self.results(checks)
        self.assertEqual(set(results.values()) - {'PASS'}, {'FAIL'})
        self.assertEqual([k for k, v in results.items() if v == 'FAIL'], ['wrong-binding'])

    def test_variant_count_counts_the_hidden_variant(self):
        folder = helpers.write_dump_folder(self.tmp / 'sets', [helpers.data('size_set.dump.json')])
        rows = [
            {'id': 'v', 'node': '40:1', 'measure': 'variantCount', 'op': 'eq', 'expected': 3},
            {'id': 'c', 'node': '40:1', 'measure': 'childCount', 'op': 'eq', 'expected': 3},
            {'id': 'vc', 'node': '40:1', 'measure': 'visibleChildCount', 'op': 'eq', 'expected': 2},
        ]
        done = self.run_checks(rows, folder)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('ASSERT PASS checks=3 failed=0', done.stdout)

    def test_variant_count_of_another_type_is_an_input_error(self):
        done = self.run_checks([{'id': 'v', 'node': '10:1', 'measure': 'variantCount', 'op': 'eq', 'expected': 3}])
        self.assertEqual(done.returncode, 2)
        self.assertIn('COMPONENT_SET', done.stderr)
        self.assertEqual(list((self.tmp / 'out').glob('*')), [])

    def test_contrast_ratio_measure(self):
        folder = helpers.write_dump_folder(self.tmp / 'c', [helpers.data('contrast_frame.dump.json')])
        rows = [
            {'id': 'body', 'node': '20:3', 'measure': 'contrastRatio', 'op': 'approx', 'expected': 12.63, 'tolerance': 0.005},
            {'id': 'loose', 'node': '20:9', 'measure': 'contrastRatio', 'op': 'ge', 'expected': 4.5},
            {'id': 'faint', 'node': '20:4', 'measure': 'contrastRatio', 'op': 'ge', 'expected': 4.5},
            {'id': 'hidden', 'node': '20:21', 'measure': 'contrastRatio', 'op': 'absent'},
        ]
        options = ['--vars', helpers.DATA / 'variables.json', '--config', helpers.DATA / 'config.json']
        done = self.run_checks(rows, folder, *options)
        self.assertEqual(done.returncode, 1, done.stderr)
        results = {r['id']: r for r in self.report()['results']}
        self.assertEqual(
            {k: v['result'] for k, v in results.items()},
            {'body': 'PASS', 'loose': 'PASS', 'faint': 'FAIL', 'hidden': 'PASS'},
        )
        self.assertEqual(results['faint']['observed'], 1.45)

    def test_contrast_ratio_needs_vars_and_config(self):
        done = self.run_checks([{'id': 'x', 'node': '10:2', 'measure': 'contrastRatio', 'op': 'ge', 'expected': 1}])
        self.assertEqual(done.returncode, 2)
        self.assertIn('--vars', done.stderr)

    def test_a_node_of_any_root_of_a_folder_is_found(self):
        folder = helpers.write_dump_folder(self.tmp / 'two', [helpers.data(CENSUS), helpers.data('size_set.dump.json')])
        rows = [{'id': 'second', 'node': '40:2', 'field': 'name', 'op': 'eq', 'expected': 'Size=S'}]
        self.assertEqual(self.run_checks(rows, folder).returncode, 0)
        done = self.run_checks(rows, folder, '--root', '10:1')
        self.assertEqual(done.returncode, 2)
        self.assertIn('40:2', done.stderr)

    def test_baseline_dump(self):
        rows = [{'id': 'b', 'node': '10:3', 'field': 'name', 'op': 'eq', 'expected': 'synthetic/tile'}]
        done = self.run_checks(rows, helpers.DATA / 'census_frame.baseline.json')
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_outputs_hold_a_table_and_json(self):
        done = self.run_checks([GOOD, {**GOOD, 'id': 'f', 'expected': 'x'}])
        self.assertEqual(done.returncode, 1)
        text = (self.tmp / 'out' / 'checks.assert.txt').read_text(encoding='utf-8')
        self.assertIn('ASSERT FAIL checks=2 failed=1', text)
        lines = text.splitlines()
        self.assertEqual(lines[0].split(), ['ID', 'NODE', 'FIELD/MEASURE', 'OP', 'EXPECTED', 'OBSERVED', 'RESULT'])
        self.assertEqual([line.split()[-1] for line in lines[1:3]], ['PASS', 'FAIL'])
        self.assertEqual(done.stdout.splitlines()[:3], lines[:3])
        report = self.report()
        self.assertEqual(report['results'][1]['observed'], 'synthetic/frame')
        self.assertEqual(report['results'][1]['expected'], 'x')
        self.assertEqual(report['summary'], {'checks': 2, 'passed': 1, 'failed': 1})
        self.assertEqual(sorted(p.name for p in (self.tmp / 'out').iterdir()), ['checks.assert.json', 'checks.assert.txt'])

    def test_exit_0_when_each_check_passes(self):
        self.assertEqual(self.run_checks([GOOD]).returncode, 0)

    def test_each_input_error_exits_with_2_and_writes_nothing(self):
        bad_rows = {
            'unknown node': {**GOOD, 'node': '99:99'},
            'unknown operator': {**GOOD, 'op': 'near'},
            'bad path': {**GOOD, 'field': 'styles.fills[x]'},
            'unknown measure': {'id': 'm', 'node': '10:1', 'measure': 'depth', 'op': 'eq', 'expected': 1},
            'both field and measure': {**GOOD, 'measure': 'childCount'},
            'neither': {'id': 'n', 'node': '10:1', 'op': 'exists'},
            'no expected': {k: v for k, v in GOOD.items() if k != 'expected'},
            'expected on exists': {**GOOD, 'op': 'exists'},
            'text for lt': {**GOOD, 'op': 'lt'},
            'list for in': {**GOOD, 'op': 'in'},
            'bad regex': {**GOOD, 'op': 'matches', 'expected': '('},
            'approx without tolerance': {**GOOD, 'op': 'approx', 'expected': 1},
            'tolerance on eq': {**GOOD, 'tolerance': 1},
            'boundVariable without field': {'id': 'm', 'node': '10:1', 'measure': 'boundVariable', 'op': 'exists'},
            'argument on childCount': {'id': 'm', 'node': '10:1', 'measure': 'childCount(1)', 'op': 'eq', 'expected': 1},
            'unknown key': {**GOOD, 'extra': 1},
            'row not an object': 'x',
        }
        for label, row in bad_rows.items():
            with self.subTest(label):
                done = self.run_checks([GOOD, {**row, 'id': 'second'} if isinstance(row, dict) else row])
                self.assertEqual(done.returncode, 2, done.stdout)
                self.assertIn('checks[1]', done.stderr)
                self.assertEqual(list((self.tmp / 'out').glob('*')), [])

    def test_duplicate_ids_and_a_wrong_checks_file_exit_with_2(self):
        self.assertEqual(self.run_checks([GOOD, GOOD]).returncode, 2)
        self.assertEqual(self.run_checks([]).returncode, 2)
        self.assertEqual(self.run_checks({'id': 'g'}).returncode, 2)

    def test_all_input_errors_are_listed_together(self):
        done = self.run_checks([{**GOOD, 'op': 'bogus'}, {**GOOD, 'id': 'b', 'field': '.x'}])
        self.assertEqual(done.returncode, 2)
        self.assertIn('checks[0]', done.stderr)
        self.assertIn('checks[1]', done.stderr)

    def test_a_dump_that_does_not_match_its_manifest_exits_with_2(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data(CENSUS)])
        (folder / '10_1.json').write_bytes((folder / '10_1.json').read_bytes() + b' ')
        done = self.run_checks([GOOD], folder)
        self.assertEqual(done.returncode, 2)
        self.assertIn('manifest', done.stderr)

    def test_the_outputs_may_not_go_into_the_evidence_folder(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data(CENSUS)])
        checks = helpers.write_json(self.tmp / 'checks.json', [GOOD])
        done = helpers.run_script('assert.py', checks, folder, '--outputs', folder / 'results')
        self.assertEqual(done.returncode, 2)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ['10_1.json', 'manifest.json'])
