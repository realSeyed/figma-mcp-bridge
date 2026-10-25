#!/usr/bin/env python3
"""journal_check.py — the chain check of a journal dump.

`dump_journal` writes the write journal of the leader to disk: a canonical
JSON file with one entry for each write, in a hash chain. This script
calculates the chain again, from the file alone:

- `seq` runs from 1 with no gap;
- the `prevHash` of each entry is the `hash` of the entry before, and the
  `prevHash` of the first entry is the genesis hash (64 times `0`);
- the `hash` of each entry is the SHA-256 of its canonical JSON without
  `hash`;
- the head (the `hash` of the last entry) and the entry count equal the
  `headHash` and the `entryCount` of the manifest.

With `--after <hash>` (or `afterHead` of the expected file) the entries after
that head are the new entries, and with `--expected` the new entries must match
a list of expected writes one for one, in order, and in number.

The journal file is read only through its manifest: the bytes one time, the
size and the SHA-256 compared with the manifest. Exit code 1 means a check
failed, exit code 2 an input that cannot be used (a changed file included).
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.manifest import (  # noqa: E402
    DUMP_MANIFEST_NAME,
    GENESIS_HASH,
    canonical_json,
    load_manifest,
    sha256_bytes,
)
from auditlib.outputs import OutputDir  # noqa: E402

HASH = re.compile(r'[0-9a-f]{64}')
SHOWN_CHARS = 120
"""A value in a FAIL line is cut to this length: a line names the item, not the whole journal."""

ITEM_KEYS = ('tool', 'fileKey', 'nodeIds', 'params', 'ok', 'response')
EXPECTED_KEYS = ('afterHead', 'writes')


def shown(value) -> str:
    """A value as a short canonical JSON text, for a FAIL line."""
    try:
        text = canonical_json(value)
    except (TypeError, ValueError):
        text = repr(value)
    return text if len(text) <= SHOWN_CHARS else text[: SHOWN_CHARS - 1] + '…'


class Checks:
    """The checks of one run, in order: a PASS line or a FAIL line for each."""

    def __init__(self):
        self.items = []

    def passed(self, name, detail):
        self.items.append({'check': name, 'ok': True, 'detail': detail})

    def failed(self, name, detail):
        self.items.append({'check': name, 'ok': False, 'detail': detail})

    def record(self, ok, name, detail):
        self.items.append({'check': name, 'ok': ok, 'detail': detail})

    @property
    def failures(self) -> int:
        return sum(1 for item in self.items if not item['ok'])

    def lines(self):
        return [f'{"PASS" if item["ok"] else "FAIL"} {item["check"]}: {item["detail"]}' for item in self.items]


# ---- inputs ----------------------------------------------------------------


def hash_argument(value: str, option: str) -> str:
    """A hash given on the command line: 64 hexadecimal characters, as lowercase."""
    if not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        raise cli.InputError(
            f'{option}: "{value}" is not a hash of 64 hexadecimal characters. Give the genesis hash '
            '(64 times 0) or the hash of an entry of the journal.'
        )
    return value.lower()


def read_expected(path) -> dict:
    """Reads and checks an expected-writes file. Every bad item is named in one error."""
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError as err:
        raise cli.InputError(f'{path}: the expected-writes file cannot be read ({err.strerror}).') from None
    try:
        data = json.loads(raw.decode('utf-8-sig'))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise cli.InputError(f'{path}: the expected-writes file is not valid JSON: {err}') from None

    problems = []
    if not isinstance(data, dict):
        raise cli.InputError(f'{path}: the expected-writes file must be an object with a "writes" list.')
    for key in data:
        if key not in EXPECTED_KEYS:
            problems.append(f'unknown key "{key}"; the keys are {", ".join(EXPECTED_KEYS)}')
    after_head = data.get('afterHead')
    if 'afterHead' in data and not (isinstance(after_head, str) and HASH.fullmatch(after_head.lower())):
        problems.append('afterHead must be a hash of 64 hexadecimal characters')
    writes = data.get('writes')
    if not isinstance(writes, list):
        problems.append('writes must be a list')
    else:
        for index, item in enumerate(writes):
            problems.extend(f'writes[{index}]: {cause}' for cause in item_problems(item))
    if problems:
        listing = '\n'.join(f'  {problem}' for problem in problems)
        raise cli.InputError(f'{path}: the expected-writes file has {len(problems)} bad value(s):\n{listing}')
    return data


def item_problems(item) -> list[str]:
    """What is wrong with one item of the expected list; empty when it is good."""
    if not isinstance(item, dict):
        return ['the item must be an object with at least the key "tool"']
    problems = []
    for key in item:
        if key not in ITEM_KEYS:
            problems.append(f'unknown key "{key}"; the keys are {", ".join(ITEM_KEYS)}')
    if 'tool' not in item:
        problems.append('the key "tool" is missing')
    elif not isinstance(item['tool'], str) or not item['tool']:
        problems.append('tool must be a non-empty string')
    if 'fileKey' in item and not isinstance(item['fileKey'], str):
        problems.append('fileKey must be a string')
    node_ids = item.get('nodeIds', [])
    if node_ids is not None and not (isinstance(node_ids, list) and all(isinstance(n, str) for n in node_ids)):
        problems.append('nodeIds must be null or a list of strings')
    if 'params' in item and not isinstance(item['params'], dict):
        problems.append('params must be an object')
    if 'ok' in item and not isinstance(item['ok'], bool):
        problems.append('ok must be true or false')
    return problems


def manifest_path_of(source) -> Path:
    """The manifest of a journal dump: the given file, or `manifest.json` of the given folder."""
    path = Path(source)
    return path / DUMP_MANIFEST_NAME if path.is_dir() else path


def read_journal(source):
    """The manifest, the figures it gives, and the parsed `journal.json`, after the SHA-256 check."""
    manifest = load_manifest(manifest_path_of(source))
    entry = manifest.journal_entry()
    data = manifest.data
    count, head = data.get('entryCount'), data.get('headHash')
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise cli.InputError(f'{manifest.path}: entryCount is not an integer of 0 or more.')
    if not isinstance(head, str) or not HASH.fullmatch(head):
        raise cli.InputError(f'{manifest.path}: headHash is not a hash of 64 hexadecimal characters.')
    raw = manifest.read_verified(entry)
    try:
        journal = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise cli.InputError(f'{entry.local_path}: the journal file is not valid JSON: {err}') from None
    if not isinstance(journal, dict) or not isinstance(journal.get('entries'), list):
        raise cli.InputError(
            f'{entry.local_path}: the journal file must be an object with an "entries" list, as dump_journal writes it.'
        )
    return manifest, entry, journal


# ---- the chain -------------------------------------------------------------


def recalculated_hash(entry):
    """The SHA-256 of the canonical JSON of an entry without `hash`, or None when it cannot be written."""
    if not isinstance(entry, dict):
        return None
    try:
        text = canonical_json({key: value for key, value in entry.items() if key != 'hash'})
    except (TypeError, ValueError):
        return None
    return sha256_bytes(text.encode('utf-8'))


def check_chain(checks: Checks, journal: dict, manifest, entry_record):
    """Calculates the chain again. Returns the calculated head."""
    entries = journal['entries']
    data = manifest.data

    genesis = journal.get('genesisHash')
    checks.record(
        genesis == GENESIS_HASH,
        'genesis',
        'the genesisHash of the file is the genesis hash'
        if genesis == GENESIS_HASH
        else f'the genesisHash of the file is {shown(genesis)}, expected {GENESIS_HASH}',
    )

    seq_bad = prev_bad = hash_bad = 0
    previous = GENESIS_HASH
    head = GENESIS_HASH
    for position, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            checks.failed('entry', f'position {position} is not an object')
            seq_bad += 1
            prev_bad += 1
            hash_bad += 1
            continue
        seq = entry.get('seq')
        label = f'seq={shown(seq)} (position {position})'
        if seq != position or isinstance(seq, bool):
            checks.failed('seq', f'{label}: expected seq={position}')
            seq_bad += 1
        if entry.get('prevHash') != previous:
            checks.failed(
                'prevHash',
                f'{label}: prevHash is {shown(entry.get("prevHash"))}, expected {previous}'
                + (' (the genesis hash)' if position == 1 else ' (the hash of the entry before)'),
            )
            prev_bad += 1
        calculated = recalculated_hash(entry)
        if calculated is None:
            checks.failed('hash', f'{label}: the entry cannot be written as canonical JSON')
            hash_bad += 1
        elif entry.get('hash') != calculated:
            checks.failed('hash', f'{label}: hash is {shown(entry.get("hash"))}, calculated {calculated}')
            hash_bad += 1
        previous = entry.get('hash')
        head = calculated if calculated is not None else str(previous)

    count = len(entries)
    if not seq_bad:
        checks.passed('seq', f'{count} entries, seq 1 to {count} with no gap' if count else 'no entries')
    if not prev_bad:
        checks.passed('prevHash', 'each prevHash is the hash of the entry before; the first is the genesis hash')
    if not hash_bad:
        checks.passed('hash', f'each of the {count} hashes is the SHA-256 of its entry without hash')

    expected_count = data.get('entryCount')
    checks.record(
        count == expected_count,
        'entryCount',
        f'{count} entries, as the manifest says'
        if count == expected_count
        else f'the file holds {count} entries, the manifest gives {expected_count}',
    )
    listed = entry_record.record.get('entryCount')
    checks.record(
        count == listed,
        'files.entryCount',
        f'{count} entries, as the file entry of the manifest says'
        if count == listed
        else f'the file holds {count} entries, the file entry of the manifest gives {shown(listed)}',
    )
    manifest_head = data.get('headHash')
    checks.record(
        head == manifest_head,
        'head',
        f'the calculated head {head} is the headHash of the manifest'
        if head == manifest_head
        else f'the calculated head is {head}, the manifest gives {manifest_head}',
    )
    return head


# ---- the new entries and the expected writes -------------------------------


def find_after(checks: Checks, entries: list, after: str):
    """The count of entries up to and with the entry whose hash is `after`, or None when it is not in the chain."""
    if after == GENESIS_HASH:
        checks.passed('after', 'the hash is the genesis hash: each entry is new')
        return 0
    for position, entry in enumerate(entries, start=1):
        if isinstance(entry, dict) and entry.get('hash') == after:
            checks.passed('after', f'the hash is the hash of the entry seq={shown(entry.get("seq"))}')
            return position
    checks.failed('after', f'the hash {after} is neither the genesis hash nor the hash of an entry of the journal')
    return None


def response_ok(entry: dict):
    """True for a response with data, False for one with an error, None for another form."""
    response = entry.get('response')
    if isinstance(response, dict) and 'data' in response and 'error' not in response:
        return True
    if isinstance(response, dict) and 'error' in response and 'data' not in response:
        return False
    return None


def same_json(a, b) -> bool:
    try:
        return canonical_json(a) == canonical_json(b)
    except (TypeError, ValueError):
        return False


def check_item(checks: Checks, index: int, item: dict, entry) -> None:
    """Compares one new entry with one expected item. One FAIL for each key that differs, else one PASS."""
    seq = entry.get('seq') if isinstance(entry, dict) else None
    where = f'writes[{index}] seq={shown(seq)}'
    if not isinstance(entry, dict):
        checks.failed(f'writes[{index}]', f'{where}: the entry is not an object')
        return
    failed = []

    def differ(key, observed, expected):
        failed.append(key)
        checks.failed(f'writes[{index}].{key}', f'seq={shown(seq)}: observed {shown(observed)}, expected {shown(expected)}')

    if entry.get('tool') != item['tool']:
        differ('tool', entry.get('tool'), item['tool'])
    if 'fileKey' in item and entry.get('fileKey') != item['fileKey']:
        differ('fileKey', entry.get('fileKey'), item['fileKey'])
    if 'nodeIds' in item and not same_json(entry.get('nodeIds'), item['nodeIds']):
        differ('nodeIds', entry.get('nodeIds'), item['nodeIds'])
    if 'params' in item:
        params = entry.get('params')
        for key, value in item['params'].items():
            if not isinstance(params, dict) or key not in params:
                differ(f'params["{key}"]', '(absent)', value)
            elif not same_json(params[key], value):
                differ(f'params["{key}"]', params[key], value)
    if 'ok' in item and response_ok(entry) is not item['ok']:
        observed = {True: 'ok (data)', False: 'an error', None: 'neither data nor error'}[response_ok(entry)]
        differ('ok', observed, 'ok (data)' if item['ok'] else 'an error')
    if 'response' in item and not same_json(entry.get('response'), item['response']):
        differ('response', entry.get('response'), item['response'])

    if not failed:
        compared = [key for key in ITEM_KEYS if key in item]
        checks.passed(f'writes[{index}]', f'seq={shown(seq)} {entry.get("tool")}: {", ".join(compared)} match')


def check_writes(checks: Checks, new_entries: list, writes: list) -> None:
    """The new entries against the expected list: one for one, in order, and in number."""
    equal = len(new_entries) == len(writes)
    checks.record(
        equal,
        'writes',
        f'{len(new_entries)} new entries, as many as the {len(writes)} expected writes'
        if equal
        else f'{len(new_entries)} new entries, but the expected list has {len(writes)} writes',
    )
    for index, item in enumerate(writes):
        if index < len(new_entries):
            check_item(checks, index, item, new_entries[index])
        else:
            checks.failed(f'writes[{index}]', f'tool {item["tool"]}: no new entry for this item')
    for entry in new_entries[len(writes) :]:
        if isinstance(entry, dict):
            checks.failed('writes', f'seq={shown(entry.get("seq"))} {shown(entry.get("tool"))}: no item in the expected list')


# ---- the run ---------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description='Chain check of a journal dump')
    parser.add_argument('journal', help='The folder of a dump_journal call, or its manifest.json.')
    parser.add_argument(
        '--after', default=None, help='The head before the writes: the genesis hash or the hash of an entry.'
    )
    parser.add_argument(
        '--expected',
        default=None,
        help='An expected-writes file: { "afterHead": "<hash>", "writes": [ { "tool": "...", ... } ] }.',
    )
    parser.add_argument('--label', default='journal_check', help='The name of the outputs: <label>.journal_check.json.')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    outputs = OutputDir(args.outputs, args.fixtures)
    after = hash_argument(args.after, '--after') if args.after is not None else None
    expected = read_expected(args.expected) if args.expected else None
    manifest, entry_record, journal = read_journal(args.journal)
    if after is None:
        after = expected.get('afterHead', GENESIS_HASH).lower() if expected else None

    checks = Checks()
    head = check_chain(checks, journal, manifest, entry_record)
    entries = journal['entries']

    new_count = None
    if after is not None:
        position = find_after(checks, entries, after)
        if position is not None:
            new_entries = entries[position:]
            new_count = len(new_entries)
            if expected is not None:
                check_writes(checks, new_entries, expected['writes'])

    failures = checks.failures
    result = 'PASS' if failures == 0 else 'FAIL'
    result_line = (
        f'JOURNAL_CHECK PASS entries={len(entries)} head={head}'
        if failures == 0
        else f'JOURNAL_CHECK FAIL entries={len(entries)} head={head} failed={failures}'
    )
    lines = checks.lines() + [result_line]

    outputs.write_json(
        f'{args.label}.journal_check.json',
        {
            'result': result,
            'entries': len(entries),
            'head': head,
            'failed': failures,
            'manifest': str(manifest.path),
            'journal': {'path': str(entry_record.local_path), 'sha256': entry_record.sha256, 'bytes': entry_record.size},
            'after': after,
            'newEntries': new_count,
            'expectedWrites': len(expected['writes']) if expected else None,
            'checks': checks.items,
        },
    )
    outputs.write_text(f'{args.label}.journal_check.txt', '\n'.join(lines) + '\n')
    for line in lines:
        print(line)
    return cli.EXIT_OK if failures == 0 else cli.EXIT_FAILED


if __name__ == '__main__':
    cli.run(main)
