import csv

from . import helpers
from .helpers import TempDirTestCase

import sr_precheck
from auditlib.dumps import load_dump

# precheck_page, worked out by hand:
# - 30:3 (90, -10, 20 x 20) leaves the clipping box 30:2 (100 x 100): 10 at the top and 10 at the right.
# - 30:5 (-5, 0) leaves the open box 30:4 by 5 on the left; 30:4 does not clip.
# - 30:7 and 30:8 share (10, 10) in 30:6.
# - The top-level boxes 30:2 (0, 0, 100 x 100) and 30:4 (50, 50, 100 x 100) overlap.
DEFAULT_ROWS = [
    {'node_id': '30:3', 'type': 'RECTANGLE', 'name': 'synthetic/sticker', 'parent_id': '30:2',
     'top_level_ancestor': '30:2', 'overflow_left': 0, 'overflow_top': 10, 'overflow_right': 10, 'overflow_bottom': 0},
]
ALL_IDS = [
    ('30:3', 0),
    ('30:5', 5),
    ('30:7', 'IDENTICAL_COORDS'),
    ('30:8', 'IDENTICAL_COORDS'),
    ('30:2', 'PAGE_CHILD_OVERLAP'),
]


class PrecheckTest(TempDirTestCase):
    def test_default_mode(self):
        rows = sr_precheck.precheck(load_dump(helpers.DATA / 'precheck_page.baseline.json').visible(), 'default')
        self.assertEqual(rows, DEFAULT_ROWS)

    def test_all_mode(self):
        rows = sr_precheck.precheck(load_dump(helpers.DATA / 'precheck_page.baseline.json').visible(), 'all')
        self.assertEqual([(r['node_id'], r['overflow_left']) for r in rows], ALL_IDS)
        self.assertEqual(rows[2]['overflow_bottom'], 'count=2')
        self.assertEqual(rows[4]['overflow_top'], 'with=30:4')

    def test_dump_rows_equal_the_baseline_and_the_hidden_rows_go_apart(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('precheck_page.dump.json')])
        dump = load_dump(folder)
        self.assertEqual(sr_precheck.precheck(dump.visible(), 'default'), DEFAULT_ROWS)
        # The hidden 30:10 (95, 95, 20 x 20) leaves the clipping box by 15 at the right and at the bottom.
        self.assertEqual(sr_precheck.figures(dump, 'default'), {'rows': 1, 'hidden_rows': 1})
        hidden = sr_precheck.hidden_rows(dump, 'default', DEFAULT_ROWS)
        self.assertEqual(
            [(r['node_id'], r['overflow_right'], r['overflow_bottom']) for r in hidden], [('30:10', 15, 15)]
        )
        # In the mode all, the hidden twin 30:11 joins 30:7 and 30:8: three rows of count=3 that only
        # the hidden content makes, and the row of 30:10.
        self.assertEqual(sr_precheck.figures(dump, 'all'), {'rows': 5, 'hidden_rows': 4})
        visible = sr_precheck.precheck(dump.visible(), 'all')
        hidden = sr_precheck.hidden_rows(dump, 'all', visible)
        self.assertEqual(
            [(r['node_id'], r['overflow_bottom']) for r in hidden],
            [('30:10', 15), ('30:7', 'count=3'), ('30:8', 'count=3'), ('30:11', 'count=3')],
        )

    def test_baseline_has_no_hidden_rows(self):
        dump = load_dump(helpers.DATA / 'precheck_page.baseline.json')
        self.assertEqual(sr_precheck.figures(dump, 'all'), {'rows': 5, 'hidden_rows': None})

    def test_cli_writes_the_rows_and_the_hidden_rows(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('precheck_page.dump.json')])
        outputs = self.tmp / 'outputs'
        result = helpers.run_script('sr_precheck.py', folder, '--mode', 'default', '--outputs', outputs)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(outputs / 'precheck_default_30_1.csv', encoding='utf-8', newline='') as f:
            self.assertEqual([r['node_id'] for r in csv.DictReader(f)], ['30:3'])
        with open(outputs / 'precheck_default_30_1.hidden.csv', encoding='utf-8', newline='') as f:
            self.assertEqual([r['node_id'] for r in csv.DictReader(f)], ['30:10'])
