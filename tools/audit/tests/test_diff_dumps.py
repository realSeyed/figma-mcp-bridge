import copy
import json

from . import helpers
from .helpers import TempDirTestCase

import diff_dumps

CENSUS = 'census_frame.dump.json'


def census():
    return copy.deepcopy(helpers.data(CENSUS))


def find(node, node_id):
    if node['id'] == node_id:
        return node
    for child in node.get('children', []):
        found = find(child, node_id)
        if found:
            return found
    return None


class DiffTestCase(TempDirTestCase):
    def diff(self, mode, a, b, *extra):
        done = helpers.run_script('diff_dumps.py', '--mode', mode, a, b, '--outputs', self.tmp / 'out', *extra)
        return done

    def report(self):
        return json.loads((self.tmp / 'out' / f'diff_{self.mode}.diff.json').read_text(encoding='utf-8'))

    def folder(self, name, root, **options):
        return helpers.write_dump_folder(self.tmp / name, [root], **options)


class BytesModeTest(DiffTestCase):
    mode = 'bytes'

    def test_equal_folders(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()], variables={'collections': []})
        b = helpers.write_dump_folder(self.tmp / 'b', [census()], variables={'collections': []})
        done = self.diff('bytes', a, b)
        self.assertEqual(done.returncode, 0, done.stderr)
        report = self.report()
        self.assertTrue(report['equal'])
        self.assertEqual(report['summary'], {'equal': 2, 'different': 0, 'only_in_a': 0, 'only_in_b': 0})
        self.assertIn('result: EQUAL', (self.tmp / 'out' / 'diff_bytes.diff.txt').read_text(encoding='utf-8'))

    def test_different_and_one_sided_files(self):
        changed = census()
        changed['name'] = 'synthetic/renamed'
        a = helpers.write_dump_folder(self.tmp / 'a', [census()], variables={'collections': []})
        b = helpers.write_dump_folder(self.tmp / 'b', [changed, helpers.data('size_set.dump.json')])
        done = self.diff('bytes', a, b)
        self.assertEqual(done.returncode, 1, done.stderr)
        status = {f['file']: f['status'] for f in self.report()['files']}
        self.assertEqual(
            status, {'10_1.json': 'different', '40_1.json': 'only_in_b', 'variables.json': 'only_in_a'}
        )

    def test_a_manifest_file_works_as_the_side(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()])
        b = helpers.write_dump_folder(self.tmp / 'b', [census()])
        self.assertEqual(self.diff('bytes', a / 'manifest.json', b).returncode, 0)

    def test_a_file_that_changed_after_the_manifest_stops_the_run(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()])
        b = helpers.write_dump_folder(self.tmp / 'b', [census()])
        data = (b / '10_1.json').read_bytes()
        (b / '10_1.json').write_bytes(data.replace(b'synthetic/frame', b'synthetic/framx'))
        done = self.diff('bytes', a, b)
        self.assertEqual(done.returncode, 2)
        self.assertIn('SHA-256', done.stderr)
        self.assertFalse((self.tmp / 'out' / 'diff_bytes.diff.json').exists())

    def test_a_missing_file_stops_the_run(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()])
        b = helpers.write_dump_folder(self.tmp / 'b', [census()])
        (b / '10_1.json').unlink()
        done = self.diff('bytes', a, b)
        self.assertEqual(done.returncode, 2)
        self.assertIn('missing', done.stderr)

    def test_a_folder_without_a_manifest_is_an_input_error(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()])
        (self.tmp / 'empty').mkdir()
        self.assertEqual(self.diff('bytes', a, self.tmp / 'empty').returncode, 2)

    def test_only_does_not_apply(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()])
        ids = helpers.write_json(self.tmp / 'ids.json', ['10:1'])
        self.assertEqual(self.diff('bytes', a, a, '--only', ids).returncode, 2)

    def test_the_outputs_may_not_go_into_an_evidence_folder(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census()])
        done = helpers.run_script('diff_dumps.py', '--mode', 'bytes', a, a, '--outputs', a / 'results')
        self.assertEqual(done.returncode, 2)


class NodesModeTest(DiffTestCase):
    mode = 'nodes'

    def changed_pair(self):
        after = census()
        find(after, '10:1')['name'] = 'synthetic/frame-2'
        find(after, '10:3')['styles']['fills'][0]['color'] = '#0000ff'
        find(after, '10:3')['styles']['fills'].append({'type': 'SOLID', 'color': '#111111'})
        # 10:9 moves from 10:8 to 10:5, 10:12 goes, and 10:13 is new in 10:5.
        ramp, swatch = find(after, '10:8'), find(after, '10:5')
        step = ramp['children'].pop()
        swatch['children'] = [step, {'id': '10:13', 'name': 'synthetic/new', 'type': 'RECTANGLE', 'styles': {}}]
        hidden = find(after, '10:11')
        hidden['children'] = []
        return self.folder('before', census()), self.folder('after', after)

    def test_equal(self):
        a, b = self.folder('a', census()), self.folder('b', census())
        done = self.diff('nodes', a, b)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.report()['summary'], {'added': 0, 'removed': 0, 'changed': 0, 'unchanged': 11})

    def test_added_removed_changed_and_the_changed_field_paths(self):
        before, after = self.changed_pair()
        done = self.diff('nodes', before, after)
        self.assertEqual(done.returncode, 1, done.stderr)
        report = self.report()
        self.assertEqual([r['id'] for r in report['added']], ['10:13'])
        self.assertEqual([r['id'] for r in report['removed']], ['10:12'])
        changed = {r['id']: r['fields'] for r in report['changed']}
        self.assertEqual(
            changed,
            {
                '10:1': ['name'],
                '10:3': ['styles.fills[0].color', 'styles.fills[2]'],
                '10:9': ['parentId'],
            },
        )

    def test_the_text_summary_lists_each_row(self):
        before, after = self.changed_pair()
        self.diff('nodes', before, after)
        text = (self.tmp / 'out' / 'diff_nodes.diff.txt').read_text(encoding='utf-8')
        self.assertIn('ADDED      10:13', text)
        self.assertIn('REMOVED    10:12', text)
        self.assertIn('result: DIFFERENT', text)

    def test_a_reorder_is_a_child_order_change(self):
        after = census()
        children = find(after, '10:1')['children']
        children[0], children[1] = children[1], children[0]
        done = self.diff('nodes', self.folder('a', census()), self.folder('b', after))
        self.assertEqual(done.returncode, 1)
        self.assertEqual([(r['id'], r['fields']) for r in self.report()['changed']], [('10:1', ['childOrder'])])

    def test_key_order_and_whitespace_are_not_differences(self):
        a = self.folder('a', census())
        b = self.folder('b', json.loads(json.dumps(census(), sort_keys=True)))
        self.assertEqual(self.diff('nodes', a, b).returncode, 0)

    def test_only_limits_the_diff_to_the_change_set(self):
        before, after = self.changed_pair()
        ids = helpers.write_json(self.tmp / 'ids.json', ['10:1', '10:13', '10:2'])
        done = self.diff('nodes', before, after, '--only', ids)
        self.assertEqual(done.returncode, 1)
        report = self.report()
        self.assertEqual(
            report['summary'],
            {'added': 1, 'removed': 0, 'changed': 1, 'unchanged': 1, 'outside_change_set': 3},
        )
        self.assertEqual([r['id'] for r in report['changed']], ['10:1'])

    def test_a_change_set_with_no_change_in_it_is_equal(self):
        before, after = self.changed_pair()
        ids = self.tmp / 'ids.txt'
        ids.write_text('# untouched\n10:2\n10:4  # a row\n\n', encoding='utf-8')
        done = self.diff('nodes', before, after, '--only', ids)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.report()['summary']['unchanged'], 2)

    def test_a_change_set_with_an_unknown_id_is_an_input_error(self):
        a = self.folder('a', census())
        ids = helpers.write_json(self.tmp / 'ids.json', ['10:1', '99:9'])
        done = self.diff('nodes', a, a, '--only', ids)
        self.assertEqual(done.returncode, 2)
        self.assertIn('99:9', done.stderr)

    def test_a_bad_change_set_file_is_an_input_error(self):
        a = self.folder('a', census())
        for text in ['[1, 2]', '[', '', '# only a comment']:
            (self.tmp / 'ids.txt').write_text(text, encoding='utf-8')
            self.assertEqual(self.diff('nodes', a, a, '--only', self.tmp / 'ids.txt').returncode, 2, text)
        self.assertEqual(self.diff('nodes', a, a, '--only', self.tmp / 'missing.txt').returncode, 2)

    def test_different_formats_are_refused(self):
        a = self.folder('a', census())
        done = self.diff('nodes', helpers.DATA / 'census_frame.baseline.json', a)
        self.assertEqual(done.returncode, 2)
        self.assertIn('--mode fields', done.stderr)

    def test_different_include_hidden_options_are_refused(self):
        a = self.folder('a', census())
        b = self.folder('b', census(), include_hidden=False)
        done = self.diff('nodes', a, b)
        self.assertEqual(done.returncode, 2)
        self.assertIn('includeHidden', done.stderr)

    def test_two_baseline_files(self):
        baseline = helpers.DATA / 'size_set.baseline.json'
        self.assertEqual(self.diff('nodes', baseline, baseline).returncode, 0)

    def test_a_folder_of_more_than_one_root_is_diffed_as_one_set(self):
        a = helpers.write_dump_folder(self.tmp / 'a', [census(), helpers.data('size_set.dump.json')])
        later = helpers.data('size_set.dump.json')
        later['children'][0]['name'] = 'Size=XS'
        b = helpers.write_dump_folder(self.tmp / 'b', [census(), later])
        self.assertEqual(self.diff('nodes', a, b).returncode, 1)
        self.assertEqual([(r['id'], r['fields']) for r in self.report()['changed']], [('40:2', ['name'])])
        self.assertEqual(self.diff('nodes', a, b, '--root', '10:1').returncode, 0)


class FieldsModeTest(DiffTestCase):
    mode = 'fields'

    def baseline(self, name):
        return helpers.DATA / f'{name}.baseline.json'

    def test_a_dump_equals_its_baseline_once_the_dump_only_content_is_left_out(self):
        # The dump of census_frame holds hidden nodes, hidden paints, and added fields that its baseline lacks.
        for name in ['census_frame', 'contrast_frame', 'precheck_page', 'size_set']:
            with self.subTest(name):
                folder = self.folder(f'dump-{name}', helpers.data(f'{name}.dump.json'))
                done = self.diff('fields', self.baseline(name), folder)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('the field reactions', self.report()['ignored'])

    def test_a_changed_value_is_reported_by_path(self):
        after = census()
        find(after, '10:3')['styles']['cornerRadius'] = 99
        find(after, '10:2')['characters'] = 'Other'
        done = self.diff('fields', self.baseline('census_frame'), self.folder('d', after))
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertEqual(
            {r['id']: r['fields'] for r in self.report()['changed']},
            {'10:2': ['characters'], '10:3': ['styles.cornerRadius']},
        )

    def test_a_hidden_change_is_not_a_difference(self):
        after = census()
        find(after, '10:12')['name'] = 'synthetic/other-chip'
        find(after, '10:1')['styles']['effects'][0]['radius'] = 40
        self.assertEqual(self.diff('fields', self.baseline('census_frame'), self.folder('d', after)).returncode, 0)

    def test_the_root_defaults_to_the_root_of_the_baseline(self):
        folder = helpers.write_dump_folder(self.tmp / 'two', [helpers.data('size_set.dump.json'), census()])
        self.assertEqual(self.diff('fields', self.baseline('census_frame'), folder).returncode, 0)
        done = self.diff('fields', self.baseline('census_frame'), folder, '--root-b', '99:9')
        self.assertEqual(done.returncode, 2)
        self.assertIn('99:9', done.stderr)

    def test_the_sides_must_be_a_baseline_and_a_dump(self):
        folder = self.folder('d', census())
        self.assertEqual(self.diff('fields', folder, folder).returncode, 2)
        self.assertEqual(self.diff('fields', self.baseline('census_frame'), self.baseline('census_frame')).returncode, 2)
        self.assertEqual(self.diff('fields', folder, self.baseline('census_frame')).returncode, 2)

    def test_a_missing_input_is_an_input_error(self):
        done = self.diff('fields', self.tmp / 'nothing.json', self.folder('d', census()))
        self.assertEqual(done.returncode, 2)
        self.assertIn('missing', done.stderr)

    def test_a_dump_that_does_not_match_its_manifest_is_refused(self):
        folder = self.folder('d', census())
        (folder / '10_1.json').write_bytes((folder / '10_1.json').read_bytes() + b'\n')
        self.assertEqual(self.diff('fields', self.baseline('census_frame'), folder).returncode, 2)


class UnitTest(TempDirTestCase):
    def test_the_ignore_list_names_each_added_field(self):
        for name in ['mainComponentId', 'componentSetId', 'detachedInfo', 'reactions', 'flowStartingPoints', 'styledTextSegments']:
            self.assertIn(f'the field {name}', diff_dumps.FIELDS_IGNORED)
