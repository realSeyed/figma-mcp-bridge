import json

from . import helpers
from .helpers import TempDirTestCase

from auditlib.dumps import (
    DUMP_ADDED_FIELDS,
    FORMAT_BASELINE,
    FORMAT_DUMP_NODES,
    DumpError,
    iter_tree,
    load_all_roots,
    load_dump,
    load_variables,
)
from auditlib.manifest import sha256_file

PAIRS = [
    ('census_frame.baseline.json', 'census_frame.dump.json'),
    ('contrast_frame.baseline.json', 'contrast_frame.dump.json'),
    ('precheck_page.baseline.json', 'precheck_page.dump.json'),
    ('size_set.baseline.json', 'size_set.dump.json'),
]


def ids(tree):
    return [node['id'] for node, _ in iter_tree(tree)]


class BaselineLoaderTest(TempDirTestCase):
    def test_reads_a_baseline_file(self):
        path = helpers.DATA / 'census_frame.baseline.json'
        dump = load_dump(path)
        self.assertEqual(dump.format, FORMAT_BASELINE)
        self.assertEqual(dump.node_id, '10:1')
        self.assertEqual(dump.sha256, sha256_file(path))
        self.assertIs(dump.visible(), dump.root)
        self.assertIsNone(dump.hidden())
        self.assertIsNone(dump.include_hidden)

    def test_wrong_root_is_refused(self):
        with self.assertRaises(DumpError):
            load_dump(helpers.DATA / 'census_frame.baseline.json', root_id='10:2')

    def test_a_file_with_dump_content_and_no_manifest_is_refused(self):
        path = helpers.write_json(self.tmp / 'screen.json', helpers.golden('screen'))
        with self.assertRaises(DumpError) as caught:
            load_dump(path)
        self.assertIn('only dump_nodes writes', str(caught.exception))
        forced = load_dump(path, format='baseline')
        self.assertEqual(forced.format, FORMAT_BASELINE)

    def test_a_file_that_is_not_a_node_is_refused(self):
        path = helpers.write_json(self.tmp / 'list.json', [1, 2])
        with self.assertRaises(DumpError):
            load_dump(path)


class DumpNodesLoaderTest(TempDirTestCase):
    def test_reads_a_folder_of_one_root(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen')])
        dump = load_dump(folder)
        self.assertEqual(dump.format, FORMAT_DUMP_NODES)
        self.assertEqual(dump.node_id, 'N9')
        self.assertTrue(dump.include_hidden)
        self.assertTrue(dump.has_hidden_content)
        self.assertEqual(dump.path.name, 'N9.json')

    def test_reads_a_file_through_the_manifest_beside_it(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen'), helpers.golden('target')])
        dump = load_dump(folder / 'N17.json')
        self.assertEqual(dump.format, FORMAT_DUMP_NODES)
        self.assertEqual(dump.node_id, 'N17')

    def test_a_folder_of_several_roots_needs_the_root(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen'), helpers.golden('target')])
        with self.assertRaises(DumpError) as caught:
            load_dump(folder)
        self.assertIn('N9, N17', str(caught.exception))
        self.assertEqual(load_dump(folder, root_id='N17').node_id, 'N17')
        with self.assertRaises(DumpError):
            load_dump(folder, root_id='N99')
        self.assertEqual([d.node_id for d in load_all_roots(folder)], ['N9', 'N17'])

    def test_a_file_that_the_manifest_does_not_list_is_refused(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('target')])
        stray = helpers.write_json(folder / 'stray.json', helpers.data('census_frame.baseline.json'))
        with self.assertRaises(DumpError) as caught:
            load_dump(stray)
        self.assertIn('does not list it', str(caught.exception))

    def test_a_changed_file_stops_the_loader(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('target')])
        path = folder / 'N17.json'
        path.write_bytes(path.read_bytes().replace(b'Target', b'Tarjet'))
        with self.assertRaises(DumpError) as caught:
            load_dump(folder)
        self.assertIn('SHA-256', str(caught.exception))

    def test_a_dump_without_hidden_content_has_no_hidden_rows(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('target')], include_hidden=False)
        dump = load_dump(folder)
        self.assertFalse(dump.include_hidden)
        self.assertFalse(dump.has_hidden_content)
        self.assertIsNone(dump.hidden())

    def test_variables_from_a_dump_folder_and_from_a_baseline_file(self):
        variables = helpers.data('variables.json')
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('target')], variables=variables)
        self.assertEqual(load_variables(folder), variables)
        self.assertEqual(load_variables(folder / 'variables.json'), variables)
        self.assertEqual(load_variables(helpers.DATA / 'variables.json'), variables)
        (folder / 'variables.json').write_bytes(b'{"collections":[]}')
        with self.assertRaises(DumpError):
            load_variables(folder)


class ProjectionTest(TempDirTestCase):
    def test_the_visible_projection_of_each_dump_equals_its_baseline(self):
        for baseline_name, dump_name in PAIRS:
            with self.subTest(dump=dump_name):
                folder = helpers.write_dump_folder(self.tmp / dump_name, [helpers.data(dump_name)])
                dump = load_dump(folder)
                self.assertEqual(dump.visible(), helpers.data(baseline_name))

    def test_golden_screen(self):
        folder = helpers.write_dump_folder(self.tmp / 'run', [helpers.golden('screen')])
        dump = load_dump(folder)
        visible = dump.visible()
        self.assertEqual(
            ids(visible), ['N9', 'N10', 'IN10;N3', 'IN10;N4', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16']
        )
        by_id = {node['id']: node for node, _ in iter_tree(visible)}
        self.assertEqual(by_id['N14']['styles']['fills'], [{'color': '#00aa55', 'type': 'SOLID'}])
        self.assertEqual(by_id['N14']['styles']['effects'], [])
        for node in by_id.values():
            for key in DUMP_ADDED_FIELDS:
                self.assertNotIn(key, node)
        # The dump itself keeps everything.
        self.assertIn('IN10;N5', ids(dump.root))

        hidden = dump.hidden()
        self.assertEqual([top['id'] for top, _ in hidden.subtrees], ['IN10;N5'])
        self.assertEqual([[a['id'] for a in above] for _, above in hidden.subtrees], [['N9', 'N10']])
        self.assertEqual([(n['id'], f, i, p['color']) for n, f, i, p in hidden.paints], [('N14', 'fills', 0, '#ff0000')])
        self.assertEqual([(n['id'], i) for n, i, _ in hidden.effects], [('N14', 0)])
        self.assertEqual(hidden.node_count, 1)

    def test_a_hidden_root_stays(self):
        root = json.loads(json.dumps(helpers.golden('target')))
        root['styles']['visible'] = False
        folder = helpers.write_dump_folder(self.tmp / 'run', [root])
        dump = load_dump(folder)
        self.assertEqual(dump.visible()['id'], 'N17')
        self.assertEqual(dump.hidden().subtrees, [])
