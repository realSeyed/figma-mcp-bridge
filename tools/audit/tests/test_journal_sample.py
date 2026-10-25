import json

from . import helpers
from .helpers import DATA, TempDirTestCase

from auditlib.manifest import GENESIS_HASH, canonical_json

SAMPLE = DATA / 'journal_entries.json'


def load_sample():
    return json.loads(SAMPLE.read_text(encoding='utf-8'))


class JournalSampleTest(TempDirTestCase):
    """The bridge code made the hashes of the sample; the toolset calculates them again."""

    def test_each_hash_is_the_canonical_hash_of_its_entry(self):
        sample = load_sample()
        self.assertEqual(sample['genesisHash'], GENESIS_HASH)
        self.assertTrue(8 <= len(sample['entries']) <= 12)
        previous = GENESIS_HASH
        for index, entry in enumerate(sample['entries'], start=1):
            with self.subTest(seq=index):
                self.assertEqual(entry['seq'], index)
                self.assertEqual(entry['prevHash'], previous)
                self.assertEqual(helpers.entry_hash(entry), entry['hash'])
            previous = entry['hash']

    def test_the_canonical_form_of_the_values(self):
        entries = load_sample()['entries']
        text = canonical_json(entries)
        for number in ['0.1', '1e-7', '1e+21', '-2.5']:
            self.assertIn(number, text)
        # U+1F600 is a surrogate pair in UTF-16, so it sorts before U+E001.
        keyed = [e['params'] for e in entries if e['params'] and '\U0001f600' in e['params']]
        self.assertEqual(len(keyed), 1)
        canonical = canonical_json(keyed[0])
        self.assertLess(canonical.index('\U0001f600'), canonical.index(''))

    def test_the_sample_passes_the_chain_check_as_a_dump(self):
        entries = load_sample()['entries']
        folder = helpers.write_journal_folder(self.tmp / 'journal', entries)
        done = helpers.run_script('journal_check.py', folder, '--outputs', self.tmp / 'out')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(done.stdout.strip().splitlines()[-1], f'JOURNAL_CHECK PASS entries={len(entries)} head={entries[-1]["hash"]}')

    def test_a_changed_value_fails_the_chain_check(self):
        entries = load_sample()['entries']
        entries[3]['params']['text'] += '!'
        folder = helpers.write_journal_folder(self.tmp / 'journal', entries)
        done = helpers.run_script('journal_check.py', folder, '--outputs', self.tmp / 'out')
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn('FAIL hash: seq=4', done.stdout)
