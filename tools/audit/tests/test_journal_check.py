import json

from . import helpers
from .helpers import TempDirTestCase

from auditlib.manifest import GENESIS_HASH


class JournalCheckTestCase(TempDirTestCase):
    """Each test writes its journal dump folder at run time, as dump_journal writes it."""

    TOOLS = ['create_frame', 'set_solid_fill', 'clear_paints', 'delete_nodes']

    def setUp(self):
        super().setUp()
        self.entries = helpers.make_entries(self.TOOLS)
        self.outputs = self.tmp / 'outputs'

    def dump(self, entries=None, name='journal', **kwargs):
        return helpers.write_journal_folder(self.tmp / name, self.entries if entries is None else entries, **kwargs)

    def run_check(self, folder, *args, outputs=None):
        return helpers.run_script('journal_check.py', folder, '--outputs', outputs or self.outputs, *args)

    def expected(self, writes, **top):
        return helpers.write_json(self.tmp / 'expected-writes.json', {'writes': writes, **top})

    def result_line(self, done):
        return done.stdout.strip().splitlines()[-1]


class ChainTest(JournalCheckTestCase):
    def test_valid_journal_passes(self):
        done = self.run_check(self.dump())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.result_line(done), f'JOURNAL_CHECK PASS entries=4 head={self.entries[-1]["hash"]}')
        self.assertNotIn('FAIL', done.stdout)

    def test_the_manifest_file_works_as_the_argument(self):
        folder = self.dump()
        done = self.run_check(folder / 'manifest.json')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_outputs_hold_the_lines_and_the_figures(self):
        done = self.run_check(self.dump(), '--label', 'run1')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        text = (self.outputs / 'run1.journal_check.txt').read_text(encoding='utf-8')
        self.assertEqual(text, done.stdout)
        figures = json.loads((self.outputs / 'run1.journal_check.json').read_text(encoding='utf-8'))
        self.assertEqual(figures['result'], 'PASS')
        self.assertEqual(figures['entries'], 4)
        self.assertEqual(figures['head'], self.entries[-1]['hash'])
        self.assertEqual(figures['failed'], 0)
        self.assertTrue(all(check['ok'] for check in figures['checks']))
        # The outputs name the journal by its path and SHA-256, and carry no entry.
        self.assertNotIn('synthetic-file-key', json.dumps(figures))

    def test_default_label(self):
        self.run_check(self.dump())
        self.assertTrue((self.outputs / 'journal_check.journal_check.json').is_file())
        self.assertTrue((self.outputs / 'journal_check.journal_check.txt').is_file())

    def test_empty_journal_has_the_genesis_hash_as_head(self):
        done = self.run_check(self.dump(entries=[]))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.result_line(done), f'JOURNAL_CHECK PASS entries=0 head={GENESIS_HASH}')

    def test_changed_byte_is_an_input_error(self):
        folder = self.dump(tamper=lambda raw: raw.replace(b'create_frame', b'create_fraMe'))
        done = self.run_check(folder)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn('SHA-256', done.stderr)
        self.assertEqual(done.stdout, '')
        self.assertFalse(self.outputs.exists() and any(self.outputs.iterdir()))

    def test_wrong_hash_names_the_seq(self):
        # The tool changes, the hash stays: the manifest matches the file, the chain does not.
        entries = helpers.make_entries(self.TOOLS)
        entries[1]['tool'] = 'set_gradient_fill'
        done = self.run_check(self.dump(entries=entries))
        self.assertEqual(done.returncode, 1, done.stdout)
        lines = [line for line in done.stdout.splitlines() if line.startswith('FAIL')]
        self.assertEqual(len(lines), 1, done.stdout)
        self.assertTrue(lines[0].startswith('FAIL hash: seq=2 '), lines[0])
        self.assertIn(f'JOURNAL_CHECK FAIL entries=4 head={self.entries[-1]["hash"]} failed=1', done.stdout)

    def test_gap_in_seq(self):
        entries = helpers.make_entries(self.TOOLS)
        del entries[2]
        done = self.run_check(self.dump(entries=entries))
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL seq: seq=4 (position 3): expected seq=3', done.stdout)
        # The entry after the gap names the hash of the missing entry as its prevHash.
        self.assertIn('FAIL prevHash: seq=4 (position 3)', done.stdout)

    def test_wrong_prev_hash(self):
        entries = helpers.make_entries(self.TOOLS)
        entries[2]['prevHash'] = '1' * 64
        entries[2]['hash'] = helpers.entry_hash(entries[2])
        done = self.run_check(self.dump(entries=entries))
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL prevHash: seq=3 (position 3)', done.stdout)
        self.assertNotIn('FAIL seq', done.stdout)

    def test_wrong_prev_hash_of_the_first_entry(self):
        entries = helpers.make_entries(self.TOOLS)
        entries[0]['prevHash'] = '1' * 64
        entries[0]['hash'] = helpers.entry_hash(entries[0])
        done = self.run_check(self.dump(entries=entries))
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL prevHash: seq=1 (position 1)', done.stdout)
        self.assertIn('(the genesis hash)', done.stdout)

    def test_manifest_head_that_differs(self):
        folder = self.dump(manifest_overrides={'headHash': 'a' * 64})
        done = self.run_check(folder)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn(f'FAIL head: the calculated head is {self.entries[-1]["hash"]}, the manifest gives {"a" * 64}', done.stdout)

    def test_manifest_count_that_differs(self):
        folder = self.dump(manifest_overrides={'entryCount': 5})
        done = self.run_check(folder)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL entryCount: the file holds 4 entries, the manifest gives 5', done.stdout)

    def test_manifest_that_is_not_a_journal_manifest(self):
        folder = helpers.write_dump_folder(self.tmp / 'nodes', [helpers.golden('target')])
        done = self.run_check(folder)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn('dump_journal', done.stderr)


class AfterAndExpectedTest(JournalCheckTestCase):
    def writes(self, start=1):
        return [
            {'tool': entry['tool'], 'fileKey': 'synthetic-file-key', 'ok': True}
            for entry in self.entries[start:]
        ]

    def test_after_with_matching_expected_passes(self):
        after = self.entries[0]['hash']
        done = self.run_check(self.dump(), '--after', after, '--expected', self.expected(self.writes()))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('PASS after: the hash is the hash of the entry seq=1', done.stdout)
        self.assertIn('PASS writes: 3 new entries, as many as the 3 expected writes', done.stdout)
        self.assertEqual(done.stdout.count('PASS writes['), 3)
        figures = json.loads((self.outputs / 'journal_check.journal_check.json').read_text(encoding='utf-8'))
        self.assertEqual(figures['newEntries'], 3)
        self.assertEqual(figures['expectedWrites'], 3)

    def test_wrong_tool_names_the_item(self):
        writes = self.writes()
        writes[1]['tool'] = 'delete_variables'
        done = self.run_check(
            self.dump(), '--after', self.entries[0]['hash'], '--expected', self.expected(writes)
        )
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn(
            'FAIL writes[1].tool: seq=3: observed "clear_paints", expected "delete_variables"', done.stdout
        )
        self.assertIn('failed=1', self.result_line(done))

    def test_one_item_too_many(self):
        writes = self.writes() + [{'tool': 'create_text'}]
        done = self.run_check(
            self.dump(), '--after', self.entries[0]['hash'], '--expected', self.expected(writes)
        )
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes: 3 new entries, but the expected list has 4 writes', done.stdout)
        self.assertIn('FAIL writes[3]: tool create_text: no new entry for this item', done.stdout)

    def test_one_item_too_few(self):
        done = self.run_check(
            self.dump(), '--after', self.entries[0]['hash'], '--expected', self.expected(self.writes()[:2])
        )
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes: 3 new entries, but the expected list has 2 writes', done.stdout)
        self.assertIn('FAIL writes: seq=4 "delete_nodes": no item in the expected list', done.stdout)

    def test_after_head_of_the_expected_file_serves_when_after_is_absent(self):
        expected = self.expected(self.writes(), afterHead=self.entries[0]['hash'])
        done = self.run_check(self.dump(), '--expected', expected)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('PASS after: the hash is the hash of the entry seq=1', done.stdout)

    def test_after_overrides_the_after_head_of_the_expected_file(self):
        expected = self.expected(self.writes(start=2), afterHead=self.entries[0]['hash'])
        done = self.run_check(self.dump(), '--after', self.entries[1]['hash'], '--expected', expected)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_without_either_the_genesis_hash_is_the_start(self):
        writes = [{'tool': entry['tool']} for entry in self.entries]
        done = self.run_check(self.dump(), '--expected', self.expected(writes))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('PASS after: the hash is the genesis hash', done.stdout)

    def test_params_match_as_a_subset(self):
        entries = helpers.make_entries(
            [{'tool': 'create_frame', 'params': {'name': 'a', 'size': {'w': 1, 'h': 2}, 'extra': [1]}}]
        )
        folder = self.dump(entries=entries)
        good = self.expected([{'tool': 'create_frame', 'params': {'size': {'h': 2, 'w': 1.0}}}])
        done = self.run_check(folder, '--expected', good)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

        bad = self.expected(
            [{'tool': 'create_frame', 'params': {'name': 'b', 'missing': True}}]
        )
        done = self.run_check(folder, '--expected', bad)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes[0].params["name"]: seq=1: observed "a", expected "b"', done.stdout)
        self.assertIn('FAIL writes[0].params["missing"]: seq=1: observed "(absent)", expected true', done.stdout)

    def test_params_of_an_entry_without_params(self):
        entries = helpers.make_entries([{'tool': 'create_frame', 'params': None}])
        done = self.run_check(self.dump(entries=entries), '--expected', self.expected([{'tool': 'create_frame', 'params': {'a': 1}}]))
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes[0].params["a"]', done.stdout)

    def test_response_compares_as_canonical_json(self):
        entries = helpers.make_entries(
            [{'tool': 'create_frame', 'response': {'data': {'b': 1, 'a': [2.0, None]}}}]
        )
        folder = self.dump(entries=entries)
        same = self.expected([{'tool': 'create_frame', 'response': {'data': {'a': [2, None], 'b': 1}}}])
        self.assertEqual(self.run_check(folder, '--expected', same).returncode, 0)
        other = self.expected([{'tool': 'create_frame', 'response': {'data': {'a': [3, None], 'b': 1}}}])
        done = self.run_check(folder, '--expected', other)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes[0].response: seq=1:', done.stdout)

    def test_ok_false_needs_an_error_response(self):
        entries = helpers.make_entries(['create_frame', {'tool': 'clear_paints', 'ok': False}])
        folder = self.dump(entries=entries)
        good = self.expected([{'tool': 'create_frame', 'ok': True}, {'tool': 'clear_paints', 'ok': False}])
        self.assertEqual(self.run_check(folder, '--expected', good).returncode, 0)
        bad = self.expected([{'tool': 'create_frame', 'ok': False}, {'tool': 'clear_paints', 'ok': True}])
        done = self.run_check(folder, '--expected', bad)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes[0].ok: seq=1: observed "ok (data)", expected "an error"', done.stdout)
        self.assertIn('FAIL writes[1].ok: seq=2: observed "an error", expected "ok (data)"', done.stdout)

    def test_file_key_and_node_ids(self):
        entries = helpers.make_entries([{'tool': 'create_frame', 'nodeIds': None}])
        folder = self.dump(entries=entries)
        good = self.expected([{'tool': 'create_frame', 'fileKey': 'synthetic-file-key', 'nodeIds': None}])
        self.assertEqual(self.run_check(folder, '--expected', good).returncode, 0)
        bad = self.expected([{'tool': 'create_frame', 'fileKey': 'other-key', 'nodeIds': ['1:1']}])
        done = self.run_check(folder, '--expected', bad)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL writes[0].fileKey', done.stdout)
        self.assertIn('FAIL writes[0].nodeIds', done.stdout)

    def test_after_that_is_not_in_the_chain(self):
        done = self.run_check(self.dump(), '--after', 'b' * 64)
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL after: the hash', done.stdout)
        self.assertIn('neither the genesis hash nor the hash of an entry', done.stdout)

    def test_after_that_is_not_a_hash(self):
        for value in ['abc', 'g' * 64, 'a' * 63, 'a' * 65]:
            with self.subTest(value=value):
                done = self.run_check(self.dump(name=f'journal-{len(value)}{value[0]}'), '--after', value)
                self.assertEqual(done.returncode, 2, done.stdout)
                self.assertIn('--after', done.stderr)

    def test_unknown_key_and_missing_tool_are_input_errors(self):
        expected = self.expected(
            [
                {'tool': 'create_frame'},
                {'tool': 'create_frame', 'name': 'x'},
                {'fileKey': 'synthetic-file-key'},
                'create_frame',
                {'tool': 'create_frame', 'ok': 'yes', 'params': []},
            ]
        )
        done = self.run_check(self.dump(), '--expected', expected)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertEqual(done.stdout, '')
        self.assertNotIn('writes[0]', done.stderr)
        self.assertIn('writes[1]: unknown key "name"', done.stderr)
        self.assertIn('writes[2]: the key "tool" is missing', done.stderr)
        self.assertIn('writes[3]: the item must be an object', done.stderr)
        self.assertIn('writes[4]: ok must be true or false', done.stderr)
        self.assertIn('writes[4]: params must be an object', done.stderr)

    def test_writes_that_is_not_a_list_is_an_input_error(self):
        expected = helpers.write_json(self.tmp / 'expected-writes.json', {'writes': {'tool': 'create_frame'}})
        done = self.run_check(self.dump(), '--expected', expected)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn('writes must be a list', done.stderr)

    def test_unknown_key_of_the_expected_file_is_an_input_error(self):
        expected = self.expected(self.writes(), after='x')
        done = self.run_check(self.dump(), '--expected', expected)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn('unknown key "after"', done.stderr)

    def test_after_head_that_is_not_a_hash_is_an_input_error(self):
        done = self.run_check(self.dump(), '--expected', self.expected(self.writes(), afterHead='nope'))
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn('afterHead', done.stderr)


class OutputsTest(JournalCheckTestCase):
    def test_outputs_inside_the_dump_folder_are_refused(self):
        folder = self.dump()
        done = self.run_check(folder, outputs=folder / 'outputs')
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn('evidence folder', done.stderr)
        self.assertFalse((folder / 'outputs').exists())

    def test_the_dump_folder_itself_is_refused(self):
        folder = self.dump()
        done = self.run_check(folder, outputs=folder)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn('evidence folder', done.stderr)
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ['journal.json', 'manifest.json'])
