import json

from . import helpers
from .helpers import TempDirTestCase

import completeness
from auditlib.dumps import load_dump

COMPONENTS = helpers.data('components.json')
PAGE_COUNTS = helpers.data('page_child_counts.json')


class SetCompletenessTest(TempDirTestCase):
    def test_golden_set_matches_the_listing(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('button-set')])
        check = completeness.check_set_completeness(load_dump(folder), COMPONENTS)
        self.assertEqual(
            check, {'result': 'PASS', 'carried': 2, 'expected': 2, 'expected_source': 'list_components', 'hidden': 0}
        )

    def test_a_dump_counts_the_hidden_variant_that_a_read_leaves_out(self):
        # The listing gives 3 variants; Size=L is hidden, so the read carries 2 and the dump 3.
        read = completeness.check_set_completeness(load_dump(helpers.DATA / 'size_set.baseline.json'), COMPONENTS)
        self.assertEqual(
            read, {'result': 'FAIL', 'carried': 2, 'expected': 3, 'expected_source': 'list_components', 'hidden': None}
        )
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('size_set.dump.json')])
        dumped = completeness.check_set_completeness(load_dump(folder), COMPONENTS)
        self.assertEqual(
            dumped, {'result': 'PASS', 'carried': 3, 'expected': 3, 'expected_source': 'list_components', 'hidden': 1}
        )

    def test_a_get_component_result_gives_the_count(self):
        check = completeness.check_set_completeness(
            load_dump(helpers.DATA / 'size_set.baseline.json'), {'variantCount': 2}
        )
        self.assertEqual(check['result'], 'PASS')

    def test_an_unlisted_set_falls_back_and_is_unchecked(self):
        check = completeness.check_set_completeness(load_dump(helpers.DATA / 'size_set.baseline.json'), {'items': []})
        self.assertEqual(
            check, {'result': 'PASS', 'carried': 2, 'expected': 2, 'expected_source': 'carried', 'hidden': None}
        )
        self.assertEqual(completeness.verdict(check, completeness.SOURCE_LISTING), 'UNCHECKED')


class PageCompletenessTest(TempDirTestCase):
    def test_a_read_misses_the_hidden_child_and_the_dump_has_it(self):
        read = completeness.check_page_completeness(load_dump(helpers.DATA / 'precheck_page.baseline.json'), PAGE_COUNTS)
        self.assertEqual(
            read, {'result': 'FAIL', 'carried': 3, 'expected': 4, 'expected_source': 'page_child_counts', 'hidden': None}
        )
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.data('precheck_page.dump.json')])
        dumped = completeness.check_page_completeness(load_dump(folder), PAGE_COUNTS)
        self.assertEqual(
            dumped, {'result': 'PASS', 'carried': 4, 'expected': 4, 'expected_source': 'page_child_counts', 'hidden': 1}
        )

    def test_an_unlisted_page_expects_zero(self):
        check = completeness.check_page_completeness(load_dump(helpers.DATA / 'precheck_page.baseline.json'), [])
        self.assertEqual(check['expected'], 0)
        self.assertEqual(check['expected_source'], 'missing')


class NestedShortfallTest(TempDirTestCase):
    def test_a_cut_read(self):
        figures = completeness.figures(load_dump(helpers.DATA / 'cut_read.baseline.json'))
        self.assertEqual(figures['nested_shortfalls'], {'50:1': {'carried': 1, 'expected': 3}})
        self.assertIsNone(figures['set_completeness'])
        self.assertIsNone(figures['page_completeness'])


class CompletenessCliTest(TempDirTestCase):
    def test_each_root_of_a_folder(self):
        folder = helpers.write_dump_folder(
            self.tmp / 'run', [helpers.data('size_set.dump.json'), helpers.data('precheck_page.dump.json')]
        )
        outputs = self.tmp / 'outputs'
        result = helpers.run_script(
            'completeness.py', folder, '--components', helpers.DATA / 'components.json',
            '--page-child-counts', helpers.DATA / 'page_child_counts.json', '--outputs', outputs,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('PASS set 40:1 carried=3 expected=3 source=list_components hidden=1', result.stdout)
        self.assertIn('PASS page 30:1 carried=4 expected=4 source=page_child_counts hidden=1', result.stdout)
        written = json.loads((outputs / 'completeness.json').read_text(encoding='utf-8'))
        self.assertEqual([r['root_id'] for r in written], ['40:1', '30:1'])

    def test_fails_on_a_difference_and_on_an_unlisted_set(self):
        outputs = self.tmp / 'outputs'
        result = helpers.run_script(
            'completeness.py', helpers.DATA / 'size_set.baseline.json', '--components',
            helpers.DATA / 'components.json', '--outputs', outputs,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL set 40:1 carried=2 expected=3 source=list_components', result.stdout)
        empty = helpers.write_json(self.tmp / 'empty.json', {'items': []})
        result = helpers.run_script(
            'completeness.py', helpers.DATA / 'size_set.baseline.json', '--components', empty, '--outputs', outputs
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn('UNCHECKED set 40:1', result.stdout)
