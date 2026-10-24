import csv
import json

from . import helpers
from .helpers import TempDirTestCase

import census
from auditlib.config import ConfigError, load_config
from auditlib.dumps import load_dump

# The figures of census_frame, worked out by hand:
# - unbound SOLID paints: 10:2 #333333, 10:3 #00ff00, 10:4 #333333 (a stroke), and 10:5 #123456, which is
#   exempt. 10:3 binds one of its two paints; the node-level list has one entry, so the census takes the
#   first paint as the bound one and counts the second.
# - radius: 10:1 (8, bound on the four corners), 10:3 (4), 10:4 (mixed, top left 6).
# - spacing on the scale {8, 16}: 10:1 gap 12 (off), padding right 16 and left 16 (on; top and bottom
#   bound); 10:4 padding right 24 and left 24 (off); its gap 0 and its zero paddings do not count.
# - theme bindings to palette-a: 10:1 fills and 10:3 fills; 10:8 and 10:9 lie in an exempt subtree.
VISIBLE = {
    'root_id': '10:1',
    'root_name': 'synthetic/frame',
    'unbound_paints': {
        'count': 3,
        'colours': {'#333333': 2, '#00ff00': 1},
        'exempt': 1,
        'total': 4,
        'colours_all': {'#333333': 2, '#00ff00': 1, '#123456': 1},
    },
    'radius': {'bearing': 3, 'bound': 1, 'raw': 2},
    'spacing': {'raw_nonzero': 5, 'on_scale': 2, 'off_scale': 3, 'off_scale_values': {'12': 1, '24': 2}},
    'theme_or_raw_binding_entries_outside_exemptions': 2,
    'nested_shortfalls': {},
}

# The hidden content of the dump form: the hidden frame 10:11 (#abcdef, radius 2, gap 20) with its child
# 10:12, whose paint carries its own binding to palette-a, and the hidden paint #ff00ff of 10:2.
HIDDEN = {
    'nodes': 2,
    'paints': 1,
    'unbound_paints': {'count': 2, 'colours': {'#ff00ff': 1, '#abcdef': 1}, 'exempt': 0},
    'radius': {'bearing': 1, 'bound': 0, 'raw': 1},
    'spacing': {'raw_nonzero': 1, 'on_scale': 0, 'off_scale': 1, 'off_scale_values': {'20': 1}},
    'theme_or_raw_binding_entries_outside_exemptions': 1,
}

FINDINGS = [
    ('10:2', 'paint', 'fills', '#333333', 'unbound_paint'),
    ('10:3', 'paint', 'fills', '#00ff00', 'unbound_paint'),
    ('10:4', 'paint', 'strokes', '#333333', 'unbound_paint'),
    ('10:3', 'radius', 'cornerRadius', '', 'raw_radius'),
    ('10:4', 'radius', 'cornerRadius', '', 'raw_radius'),
    ('10:1', 'spacing', 'gap', '12', 'raw_spacing_off_scale'),
    ('10:4', 'spacing', 'right', '24', 'raw_spacing_off_scale'),
    ('10:4', 'spacing', 'left', '24', 'raw_spacing_off_scale'),
    ('10:1', 'binding', 'fills', 'VariableID:91:3', 'theme_or_raw_binding'),
    ('10:3', 'binding', 'fills', 'VariableID:91:2', 'theme_or_raw_binding'),
]

HIDDEN_FINDINGS = [
    ('10:2', 'paint', 'fills', '#ff00ff', 'hidden_unbound_paint'),
    ('10:11', 'paint', 'fills', '#abcdef', 'hidden_unbound_paint'),
    ('10:11', 'radius', 'cornerRadius', '', 'hidden_raw_radius'),
    ('10:11', 'spacing', 'gap', '20', 'hidden_raw_spacing_off_scale'),
    ('10:12', 'binding', 'fills', 'VariableID:91:2', 'hidden_theme_or_raw_binding'),
]


def rows(findings):
    return [(f['node_id'], f['type'], f['field'], f['value'], f['category']) for f in findings]


def without_source(figures):
    return {k: v for k, v in figures.items() if k not in ('source', 'hidden_content')}


class CensusTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.variables = helpers.data('variables.json')
        self.exemptions = helpers.data('exemptions.json')
        self.config = load_config(helpers.DATA / 'config.json')

    def census(self, dump):
        return census.run_census(dump, self.variables, self.exemptions, self.config)

    def test_baseline_figures(self):
        figures, findings = self.census(load_dump(helpers.DATA / 'census_frame.baseline.json'))
        self.assertEqual(without_source(figures), VISIBLE)
        self.assertIsNone(figures['hidden_content'])
        self.assertEqual(figures['source']['format'], 'baseline')
        self.assertEqual(rows(findings), FINDINGS)

    def test_dump_figures_equal_the_baseline_and_report_the_hidden_content_apart(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('census_frame.dump.json')])
        figures, findings = self.census(load_dump(folder))
        self.assertEqual(without_source(figures), VISIBLE)
        self.assertEqual(figures['hidden_content'], HIDDEN)
        self.assertEqual(rows(findings), FINDINGS + HIDDEN_FINDINGS)

    def test_golden_screen(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen')])
        figures = census.figures(load_dump(folder), self.variables, self.exemptions, self.config)
        self.assertEqual(
            figures['unbound_paints'],
            {
                'count': 9,
                'colours': {
                    '#ffffff': 1,
                    '#e8ecf4': 1,
                    '#11151c': 2,
                    '#ff7755': 2,
                    '#d0d7e6': 1,
                    '#00aa55': 1,
                    '#3355ff': 1,
                },
                'exempt': 0,
                'total': 9,
                'colours_all': {
                    '#ffffff': 1,
                    '#e8ecf4': 1,
                    '#11151c': 2,
                    '#ff7755': 2,
                    '#d0d7e6': 1,
                    '#00aa55': 1,
                    '#3355ff': 1,
                },
            },
        )
        self.assertEqual(figures['radius'], {'bearing': 0, 'bound': 0, 'raw': 0})
        self.assertEqual(figures['hidden_content']['nodes'], 1)
        self.assertEqual(figures['hidden_content']['paints'], 1)
        self.assertEqual(
            figures['hidden_content']['unbound_paints'],
            {'count': 2, 'colours': {'#ff0000': 1, '#d92d20': 1}, 'exempt': 0},
        )

    def test_golden_button_set(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('button-set')])
        figures = census.figures(load_dump(folder), self.variables, self.exemptions, self.config)
        self.assertEqual(figures['radius'], {'bearing': 1, 'bound': 0, 'raw': 1})
        self.assertEqual(figures['unbound_paints']['count'], 6)
        self.assertEqual(figures['hidden_content']['unbound_paints']['colours'], {'#d92d20': 1})

    def test_nested_shortfalls_of_a_cut_read(self):
        figures = census.figures(
            load_dump(helpers.DATA / 'cut_read.baseline.json'), self.variables, self.exemptions, self.config
        )
        self.assertEqual(figures['nested_shortfalls'], {'50:1': {'carried': 1, 'expected': 3}})

    def test_a_missing_collection_name_stops(self):
        with self.assertRaises(ConfigError) as caught:
            census.run_census(
                load_dump(helpers.DATA / 'census_frame.baseline.json'), self.variables, self.exemptions, load_config(None)
            )
        self.assertIn('spacing_collection', str(caught.exception))


class InstancedSetsTest(TempDirTestCase):
    def test_dump_format_reads_the_set_of_each_instance(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen')])
        visible, hidden = census.instanced_sets([load_dump(folder)], {}, helpers.data('components.json'))
        self.assertEqual(
            visible,
            [
                {
                    'component_set_id': 'N1',
                    'component_set_name': 'mcp-e2e/conformance/Button',
                    'instance_count': 1,
                    'pages': 'mcp-e2e/conformance/Screen',
                }
            ],
        )
        self.assertEqual(hidden, [])

    def test_an_instance_in_hidden_content_goes_to_the_hidden_rows(self):
        screen = helpers.golden('screen')
        screen['children'][0]['styles']['visible'] = False
        folder = helpers.write_dump_folder(self.tmp / 'run', [screen])
        visible, hidden = census.instanced_sets([load_dump(folder)], {}, None)
        self.assertEqual(visible, [])
        self.assertEqual([(r['component_set_id'], r['instance_count']) for r in hidden], [('N1', 1)])

    def test_baseline_format_reads_the_cache(self):
        dump = load_dump(helpers.DATA / 'contrast_frame.baseline.json')
        cache = {'20:12': {'mainComponent': {'parentSetId': '60:1', 'parentSetName': 'synthetic/Toggle'}}}
        visible, _ = census.instanced_sets([dump], cache, None)
        self.assertEqual(
            visible,
            [
                {
                    'component_set_id': '60:1',
                    'component_set_name': 'synthetic/Toggle',
                    'instance_count': 1,
                    'pages': 'synthetic/screen',
                }
            ],
        )

    def test_cli_needs_the_cache_for_a_baseline_dump(self):
        result = helpers.run_script(
            'census.py',
            'instanced-sets',
            '--dumps',
            helpers.DATA / 'contrast_frame.baseline.json',
            '--outputs',
            self.tmp / 'outputs',
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn('--cache', result.stderr)


class CensusCliTest(TempDirTestCase):
    def args(self, dump, outputs):
        return [
            'audit',
            dump,
            '--label',
            'frame',
            '--vars',
            helpers.DATA / 'variables.json',
            '--exemptions',
            helpers.DATA / 'exemptions.json',
            '--config',
            helpers.DATA / 'config.json',
            '--outputs',
            outputs,
        ]

    def test_writes_the_census_and_the_findings(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('census_frame.dump.json')])
        result = helpers.run_script('census.py', *self.args(folder, self.tmp / 'outputs'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Hidden content, not in the figures above: 2 nodes, 1 hidden paints', result.stdout)
        written = json.loads((self.tmp / 'outputs' / 'frame.census.json').read_text(encoding='utf-8'))
        self.assertEqual(without_source(written), VISIBLE)
        self.assertEqual(written['hidden_content'], HIDDEN)
        with open(self.tmp / 'outputs' / 'frame.findings.csv', encoding='utf-8', newline='') as f:
            found = [tuple(r.values()) for r in csv.DictReader(f)]
        self.assertEqual(found, FINDINGS + HIDDEN_FINDINGS)

    def test_refuses_outputs_in_the_evidence_folder(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('census_frame.dump.json')])
        result = helpers.run_script('census.py', *self.args(folder, folder / 'outputs'))
        self.assertEqual(result.returncode, 2)
        self.assertIn('evidence folder', result.stderr)
        self.assertFalse((folder / 'outputs').exists())
