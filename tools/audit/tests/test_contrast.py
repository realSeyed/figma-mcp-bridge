import csv
import json

from . import helpers
from .helpers import TempDirTestCase

import contrast
from auditlib.cli import InputError
from auditlib.config import AuditConfig, load_config
from auditlib.dumps import load_dump

# The pairs of contrast_frame, worked out by hand with the WCAG 2.2 formula. The card 20:2 is opaque
# white, so its texts have the base "dump". The texts on the root have no opaque base, so they sit on
# the context base roles/surface, an alias of palette/sand (#cccccc).
# - 20:4 is #333333 at 20 % over white: 0.2 * 51 + 0.8 * 255 = 214.2, which rounds to #d6d6d6.
# - #777777 on white is 4.48:1: a pass at 3:1 for the stars (20:5), 24 px (20:6), and 19 px bold (20:7),
#   a fail at 4.5:1 for 18 px bold (20:8).
# - 20:11 and 20:13 are in the disabled variant Status=Off: by the component name, and by the
#   property of the instance.
# - 20:18 has a mixed size, so it is scored as normal text.
PAIRS = {
    '20:3': {'text': '#333333', 'bg': '#ffffff', 'ratio': '12.63', 'base': 'dump', 'threshold': 4.5, 'status': 'PASS'},
    '20:4': {'text': '#d6d6d6', 'bg': '#ffffff', 'ratio': '1.45', 'base': 'dump', 'threshold': 4.5, 'status': 'FAIL'},
    '20:5': {'text': '#777777', 'bg': '#ffffff', 'ratio': '4.48', 'base': 'dump', 'threshold': 3.0, 'status': 'PASS'},
    '20:6': {'text': '#777777', 'bg': '#ffffff', 'ratio': '4.48', 'base': 'dump', 'threshold': 3.0, 'status': 'PASS'},
    '20:7': {'text': '#777777', 'bg': '#ffffff', 'ratio': '4.48', 'base': 'dump', 'threshold': 3.0, 'status': 'PASS'},
    '20:8': {'text': '#777777', 'bg': '#ffffff', 'ratio': '4.48', 'base': 'dump', 'threshold': 4.5, 'status': 'FAIL'},
    '20:9': {'text': '#333333', 'bg': '#cccccc', 'ratio': '7.87', 'base': 'context', 'threshold': 4.5, 'status': 'PASS'},
    '20:11': {'text': '#cccccc', 'bg': '#ffffff', 'ratio': '1.61', 'base': 'dump', 'threshold': 4.5, 'status': 'EXEMPT'},
    '20:13': {'text': '#cccccc', 'bg': '#ffffff', 'ratio': '1.61', 'base': 'dump', 'threshold': 4.5, 'status': 'EXEMPT'},
    '20:18': {'text': '#777777', 'bg': '#cccccc', 'ratio': '2.79', 'base': 'context', 'threshold': 4.5, 'status': 'FAIL'},
}

SUMMARY = {
    'active_dump': {'computed': 6, 'passing': 4, 'failing': 2},
    'active_context': {'computed': 2, 'passing': 1, 'failing': 1, 'failing_ids': ['20:18']},
    'exempt': 2,
    'not_computed': 3,
    'hidden': 0,
    'labels': 10,
}

NOT_COMPUTED = [('20:14', 'no_text_fill'), ('20:16', 'non_solid_shows_through'), ('20:17', 'mixed_text_fill')]


class ContrastTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.variables = helpers.data('variables.json')
        self.config = load_config(helpers.DATA / 'config.json')

    def figures(self, dumps, **options):
        return contrast.figures(dumps, self.variables, self.config, **options)

    def check_visible(self, figures):
        self.assertEqual({k: figures[k] for k in SUMMARY}, SUMMARY)
        self.assertEqual(figures['pairs'], PAIRS)

    def test_baseline_figures(self):
        figures = self.figures([load_dump(helpers.DATA / 'contrast_frame.baseline.json')])
        self.check_visible(figures)
        self.assertIsNone(figures['hidden_content'])

    def test_not_computed_reasons(self):
        dump = load_dump(helpers.DATA / 'contrast_frame.baseline.json')
        resolver = contrast.VarResolver(self.variables)
        _, not_computed, _ = contrast.audit_tree('t', dump.visible(), resolver, '#cccccc', ('Status', 'Off'))
        self.assertEqual([(r['node_id'], r['reason']) for r in not_computed], NOT_COMPUTED)

    def test_dump_figures_equal_the_baseline_and_report_the_hidden_content_apart(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('contrast_frame.dump.json')])
        dump = load_dump(folder)
        figures = self.figures([dump])
        self.check_visible(figures)
        # 20:20 is a hidden frame that holds the text 20:19; 20:21 is a hidden text. The card has a hidden paint.
        self.assertEqual(figures['hidden_content'], {'nodes': 3, 'text_nodes': 2, 'paints': 1})
        rows = contrast.hidden_text_rows('t', dump)
        self.assertEqual([(r['node_id'], r['reason']) for r in rows], [('20:19', 'under_hidden_node'), ('20:21', 'hidden_node')])

    def test_scope_of_the_children_of_matching_children(self):
        figures = self.figures([load_dump(helpers.DATA / 'contrast_frame.baseline.json')], scope='card')
        self.assertEqual(
            figures['scope'],
            {
                'dump': {'count': 6, 'text': '#333333', 'bg': '#ffffff', 'ratio': '12.63'},
                'context': {'count': 0, 'text': None, 'bg': None, 'ratio': None},
                'exempt': 0,
            },
        )

    def test_figures_over_several_roots(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen')])
        figures = self.figures([load_dump(helpers.DATA / 'contrast_frame.baseline.json'), load_dump(folder)])
        self.assertEqual(figures['active_dump'], {'computed': 8, 'passing': 6, 'failing': 2})
        self.assertEqual(figures['labels'], 12)
        self.assertEqual(figures['not_computed'], 4)
        self.assertEqual(figures['hidden_content'], {'nodes': 1, 'text_nodes': 0, 'paints': 1})

    def test_golden_screen(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen')])
        figures = self.figures([load_dump(folder)])
        self.assertEqual(figures['pairs']['IN10;N3']['ratio'], '15.45')
        self.assertEqual(figures['pairs']['IN10;N3']['bg'], '#e8ecf4')
        self.assertEqual(figures['pairs']['N12']['ratio'], '12.67')
        self.assertEqual(figures['pairs']['N12']['bg'], '#d0d7e6')
        self.assertEqual(figures['not_computed'], 1)

    def test_context_base_as_hex_and_unresolved(self):
        dump = load_dump(helpers.DATA / 'contrast_frame.baseline.json')
        figures = self.figures([dump], context_base='#000000')
        self.assertEqual(figures['pairs']['20:9']['bg'], '#000000')
        with self.assertRaises(InputError):
            self.figures([dump], context_base='palette/missing')

    def test_without_a_disabled_rule_nothing_is_exempt(self):
        config = AuditConfig(context_base='roles/surface')
        figures = contrast.figures(
            [load_dump(helpers.DATA / 'contrast_frame.baseline.json')], self.variables, config
        )
        self.assertEqual(figures['exempt'], 0)
        self.assertEqual(figures['pairs']['20:11']['status'], 'FAIL')

    def test_table(self):
        with open(helpers.DATA / 'pairings.csv', encoding='utf-8') as f:
            table = contrast.emit_table(list(csv.DictReader(f)), contrast.VarResolver(self.variables))
        lines = table.split('\n')
        self.assertIn('| ink on paper     | text       | #333333 / #FFFFFF | 12.63:1 (≥4.5:1) | PASS   |', lines)
        self.assertIn('| sand on paper    | decorative | #CCCCCC / #FFFFFF | 1.61:1           | EXEMPT |', lines)
        self.assertIn('| surface on paper | large text | #CCCCCC / #FFFFFF | 1.61:1 (≥3.0:1)  | FAIL   |', lines)


class ContrastCliTest(TempDirTestCase):
    def test_audit_writes_the_pairs_the_summary_and_the_hidden_texts(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('contrast_frame.dump.json')])
        outputs = self.tmp / 'outputs'
        result = helpers.run_script(
            'contrast.py',
            'audit',
            folder,
            '--vars',
            helpers.DATA / 'variables.json',
            '--config',
            helpers.DATA / 'config.json',
            '--label',
            'screen',
            '--outputs',
            outputs,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads((outputs / 'screen.summary.json').read_text(encoding='utf-8'))
        self.assertEqual(summary['active_dump'], SUMMARY['active_dump'])
        self.assertEqual(summary['hidden'], 0)
        self.assertEqual(summary['hidden_content'], {'nodes': 3, 'text_nodes': 2, 'paints': 1})
        with open(outputs / 'screen.pairs.csv', encoding='utf-8', newline='') as f:
            self.assertEqual([r['node_id'] for r in csv.DictReader(f)], list(PAIRS))
        with open(outputs / 'screen.hidden.csv', encoding='utf-8', newline='') as f:
            self.assertEqual([r['node_id'] for r in csv.DictReader(f)], ['20:19', '20:21'])

    def test_table_writes_the_table(self):
        outputs = self.tmp / 'outputs'
        result = helpers.run_script(
            'contrast.py', 'table', helpers.DATA / 'pairings.csv', '--vars', helpers.DATA / 'variables.json',
            '--outputs', outputs,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ink on paper', (outputs / 'contrast_table.txt').read_text(encoding='utf-8'))
