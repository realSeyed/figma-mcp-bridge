#!/usr/bin/env python3
"""diff_dumps.py — compares two dumps in one of three modes.

`--mode bytes` compares two `dump_nodes` folders file by file by SHA-256: the
dumps of the executor against the dumps of the auditor, or before against
after. Each manifest is checked first, so a file that changed after the bridge
wrote it stops the run. Each file is equal, different, or only on one side.

`--mode nodes` compares two dumps of the same format by node ID: nodes added,
nodes removed, nodes changed with the paths of the changed fields. `--only`
limits the diff to a change set. The pseudo-fields `parentId` and `childOrder`
report a move and a reorder.

`--mode fields` compares a package written before T-1 (the baseline format)
with `dump_nodes` output, field by field, over the parsed values. Key order and
whitespace play no part. The content that the old format cannot carry is
ignored (`FIELDS_IGNORED`): both sides are reduced to the visible projection
of `auditlib/dumps.py` first.

Exit codes: 0 when the sides are equal, 1 when they differ, 2 when an input is
wrong. The outputs go to the outputs folder only.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.dumps import (  # noqa: E402
    DUMP_ADDED_FIELDS,
    FORMAT_BASELINE,
    FORMAT_DUMP_NODES,
    children_of,
    index_nodes,
    load_all_roots,
    load_dump,
    visible_projection,
)
from auditlib.manifest import DUMP_MANIFEST_NAME, ManifestError, load_manifest  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402
from auditlib.paths import changed_paths  # noqa: E402

FIELDS_IGNORED = [
    'a hidden node, with its subtree',
    'a hidden paint (fills, strokes)',
    'a hidden effect',
    *[f'the field {name}' for name in DUMP_ADDED_FIELDS],
    'the boundVariables of a paint',
]
"""The content of `--mode fields` that is left out on both sides."""

LIST_LIMIT = 200
JOINED_ROOTS = 'ROOTS'
"""The type of the made-up node that holds the roots of a folder of more than one root."""


# ── Mode bytes ───────────────────────────────────────────────────────


def _open_manifest(path):
    path = Path(path)
    manifest_path = path / DUMP_MANIFEST_NAME if path.is_dir() else path
    if not manifest_path.is_file():
        raise cli.InputError(f'{path}: give a dump folder with {DUMP_MANIFEST_NAME}, or the manifest file.')
    manifest = load_manifest(manifest_path)
    manifest.verify_all()
    return manifest


def diff_bytes(path_a, path_b):
    manifest_a, manifest_b = _open_manifest(path_a), _open_manifest(path_b)
    sides = []
    for manifest in (manifest_a, manifest_b):
        by_name = {}
        for entry in manifest.entries:
            name = entry.local_path.name
            if name in by_name:
                raise cli.InputError(f'{manifest.path}: two entries share the file name {name}.')
            by_name[name] = entry
        sides.append(by_name)
    files = []
    for name in sorted(sides[0].keys() | sides[1].keys()):
        entry_a, entry_b = sides[0].get(name), sides[1].get(name)
        if entry_a is None:
            status = 'only_in_b'
        elif entry_b is None:
            status = 'only_in_a'
        else:
            status = 'equal' if entry_a.sha256 == entry_b.sha256 else 'different'
        files.append(
            {
                'file': name,
                'status': status,
                'sha256_a': entry_a.sha256 if entry_a else None,
                'sha256_b': entry_b.sha256 if entry_b else None,
            }
        )
    counts = {status: sum(1 for f in files if f['status'] == status) for status in ('equal', 'different', 'only_in_a', 'only_in_b')}
    report = {
        'mode': 'bytes',
        'a': {'manifest': str(manifest_a.path), 'files': len(manifest_a.entries)},
        'b': {'manifest': str(manifest_b.path), 'files': len(manifest_b.entries)},
        'summary': counts,
        'files': files,
    }
    lines = [f'{f["status"].upper():<10} {f["file"]}' for f in files if f['status'] != 'equal']
    text = _summary_text(
        'bytes',
        f'files: {counts["equal"]} equal, {counts["different"]} different, '
        f'{counts["only_in_a"]} only in A, {counts["only_in_b"]} only in B',
        lines,
    )
    return report, text, counts['equal'] == len(files)


# ── Modes nodes and fields ───────────────────────────────────────────


def _own_fields(node):
    return {key: value for key, value in node.items() if key != 'children'}


def _common_order(a_children, b_children):
    common = set(a_children) & set(b_children)
    return [i for i in a_children if i in common], [i for i in b_children if i in common]


def diff_trees(tree_a, tree_b, only=None):
    """The node-level diff of two trees: added, removed, changed (with the changed field paths)."""
    index_a, index_b = index_nodes(tree_a), index_nodes(tree_b)
    added, removed, changed = [], [], []
    unchanged = 0
    for node_id, (node, parent_id) in index_a.items():
        if node.get('type') == JOINED_ROOTS:
            continue
        if node_id not in index_b:
            removed.append({'id': node_id, 'type': node.get('type'), 'name': node.get('name'), 'parentId': parent_id})
            continue
        other, other_parent = index_b[node_id]
        fields = changed_paths(_own_fields(node), _own_fields(other))
        if parent_id != other_parent:
            fields.append('parentId')
        order_a, order_b = _common_order(
            [c.get('id') for c in children_of(node)], [c.get('id') for c in children_of(other)]
        )
        if order_a != order_b:
            fields.append('childOrder')
        if fields:
            changed.append({'id': node_id, 'type': other.get('type'), 'name': other.get('name'), 'fields': fields})
        else:
            unchanged += 1
    for node_id, (node, parent_id) in index_b.items():
        if node.get('type') != JOINED_ROOTS and node_id not in index_a:
            added.append({'id': node_id, 'type': node.get('type'), 'name': node.get('name'), 'parentId': parent_id})

    summary = {'added': len(added), 'removed': len(removed), 'changed': len(changed), 'unchanged': unchanged}
    if only is not None:
        unknown = sorted(only - index_a.keys() - index_b.keys())
        if unknown:
            raise cli.InputError(
                'the change set names nodes that neither side holds: ' + ', '.join(unknown[:10]) + '.'
            )
        outside = sum(1 for rows in (added, removed, changed) for row in rows if row['id'] not in only)
        added, removed, changed = (
            [row for row in rows if row['id'] in only] for rows in (added, removed, changed)
        )
        unchanged = sum(1 for node_id in only if node_id in index_a and node_id in index_b) - len(changed)
        summary = {
            'added': len(added),
            'removed': len(removed),
            'changed': len(changed),
            'unchanged': unchanged,
            'outside_change_set': outside,
        }
    return {'summary': summary, 'added': added, 'removed': removed, 'changed': changed}


def read_change_set(path):
    """A file of node IDs: a JSON array of strings, or one ID on each line (`#` starts a comment)."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except FileNotFoundError:
        raise cli.InputError(f'{path}: the change set file is missing.') from None
    except UnicodeDecodeError:
        raise cli.InputError(f'{path}: the change set file is not UTF-8 text.') from None
    if text.lstrip().startswith('['):
        try:
            ids = json.loads(text)
        except json.JSONDecodeError as err:
            raise cli.InputError(f'{path}: the change set is not valid JSON: {err}') from None
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise cli.InputError(f'{path}: the change set must be an array of node ID strings.')
    else:
        ids = [line.split('#', 1)[0].strip() for line in text.splitlines()]
        ids = [i for i in ids if i]
    if not ids:
        raise cli.InputError(f'{path}: the change set holds no node ID.')
    return set(ids)


def _one_tree(path, root_id, fmt):
    """The roots of a dump as one list of dumps: the named root, or each root of a folder."""
    return [load_dump(path, root_id, fmt)] if root_id else load_all_roots(path, fmt)


def _join(dumps, projected):
    """One tree from several roots, so that the diff sees them as one set of nodes."""
    trees = [visible_projection(d.root) if projected else d.root for d in dumps]
    if len(trees) == 1:
        return trees[0]
    return {'id': '', 'type': JOINED_ROOTS, 'children': trees}


def diff_nodes(args):
    dumps_a = _one_tree(args.a, args.root, args.format)
    dumps_b = _one_tree(args.b, args.root_b or args.root, args.format)
    formats = {d.format for d in dumps_a}, {d.format for d in dumps_b}
    if formats[0] != formats[1]:
        raise cli.InputError(
            'the two sides have different formats (baseline and dump_nodes); compare them with --mode fields.'
        )
    hidden = {d.include_hidden for d in dumps_a}, {d.include_hidden for d in dumps_b}
    if hidden[0] != hidden[1]:
        raise cli.InputError(
            'the two dump_nodes sides were made with different includeHidden options; '
            'the hidden nodes would show as added or removed. Dump both sides alike.'
        )
    only = read_change_set(args.only) if args.only else None
    result = diff_trees(_join(dumps_a, False), _join(dumps_b, False), only)
    return {
        'mode': 'nodes',
        'a': [d.source() for d in dumps_a],
        'b': [d.source() for d in dumps_b],
        **result,
    }


def diff_fields(args):
    dumps_a = _one_tree(args.a, args.root, args.format)
    if any(d.format != FORMAT_BASELINE for d in dumps_a):
        raise cli.InputError('--mode fields takes a baseline file as A; compare two dump_nodes dumps with --mode nodes.')
    if len(dumps_a) != 1:
        raise cli.InputError('--mode fields takes one baseline root as A.')
    root_b = args.root_b or args.root or dumps_a[0].node_id
    dump_b = load_dump(args.b, root_b)
    if dump_b.format != FORMAT_DUMP_NODES:
        raise cli.InputError('--mode fields takes dump_nodes output as B; compare two baseline files with --mode nodes.')
    only = read_change_set(args.only) if args.only else None
    result = diff_trees(_join(dumps_a, True), _join([dump_b], True), only)
    return {
        'mode': 'fields',
        'a': [dumps_a[0].source()],
        'b': [dump_b.source()],
        'ignored': FIELDS_IGNORED,
        **result,
    }


def nodes_text(report):
    s = report['summary']
    head = f'nodes: {s["added"]} added, {s["removed"]} removed, {s["changed"]} changed, {s["unchanged"]} unchanged'
    if 'outside_change_set' in s:
        head += f'; {s["outside_change_set"]} more differ outside the change set'
    lines = []
    lines += [f'ADDED      {row["id"]}  {row["type"]}  {row["name"]}' for row in report['added']]
    lines += [f'REMOVED    {row["id"]}  {row["type"]}  {row["name"]}' for row in report['removed']]
    lines += [f'CHANGED    {row["id"]}  {row["type"]}  {", ".join(row["fields"])}' for row in report['changed']]
    return _summary_text(report['mode'], head, lines)


def _summary_text(mode, head, lines):
    shown = lines[:LIST_LIMIT]
    more = len(lines) - len(shown)
    body = '\n'.join(shown) + (f'\n... {more} more rows; see the JSON output.' if more else '')
    return f'diff_dumps --mode {mode}\n{head}\n' + (body + '\n' if body else '')


def _equal(report):
    s = report['summary']
    return s['added'] == 0 and s['removed'] == 0 and s['changed'] == 0


def main():
    parser = argparse.ArgumentParser(description='Compare two dumps byte for byte, by node, or field by field')
    parser.add_argument('--mode', choices=['bytes', 'nodes', 'fields'], required=True)
    parser.add_argument('a', help='Side A: a dump folder, a manifest, a file in a dump folder, or a baseline file')
    parser.add_argument('b', help='Side B, of the same kind')
    parser.add_argument('--root', default=None, help='The root of side A (and of side B, if --root-b is not given)')
    parser.add_argument('--root-b', default=None, help='The root of side B, when it differs')
    parser.add_argument('--format', choices=['baseline', 'dump_nodes'], default=None, help='Force the format of side A')
    parser.add_argument('--only', default=None, help='A file of node IDs (the change set); modes nodes and fields')
    parser.add_argument('--label', default=None, help='The name prefix of the output files')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    if args.only and args.mode == 'bytes':
        raise cli.InputError('--only limits a node diff; it does not apply to --mode bytes.')
    outputs = OutputDir(args.outputs, args.fixtures)
    if args.mode == 'bytes':
        report, text, equal = diff_bytes(args.a, args.b)
    else:
        report = diff_nodes(args) if args.mode == 'nodes' else diff_fields(args)
        text = nodes_text(report)
        equal = _equal(report)
    label = args.label or f'diff_{args.mode}'
    report['equal'] = equal
    outputs.write_json(f'{label}.diff.json', report)
    outputs.write_text(f'{label}.diff.txt', text + f'result: {"EQUAL" if equal else "DIFFERENT"}\n')
    print(text + f'result: {"EQUAL" if equal else "DIFFERENT"}', end='\n')
    return cli.EXIT_OK if equal else cli.EXIT_FAILED


if __name__ == '__main__':
    cli.run(main)
