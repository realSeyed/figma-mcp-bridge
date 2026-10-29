#!/usr/bin/env python3
"""sr_precheck.py — the surface pre-check: rows that say where to look closer.

- `--mode default`: each node that overflows a parent that clips its content.
- `--mode all`: each node that escapes its parent, clipping or not; the
  siblings at identical coordinates; and the top-level children of a page
  that overlap.

A row is a pointer for the reading of the captures. The pre-check never
replaces that reading: a row is not a defect, and no row is not a pass.

The rows use the visible content: the baseline as it is, or the visible
projection of a `dump_nodes` dump. For a `dump_nodes` dump, the rows that
appear only when the hidden content is included go to `<label>.hidden.csv`.
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.dumps import FORMAT_DUMP_NODES, load_dump  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402

FIELDNAMES = [
    'node_id',
    'type',
    'name',
    'parent_id',
    'top_level_ancestor',
    'overflow_left',
    'overflow_top',
    'overflow_right',
    'overflow_bottom',
]


def format_val(v):
    v = round(v, 2)
    # An int has is_integer() only from Python 3.12, and the toolset runs on 3.11.
    return int(v) if isinstance(v, int) or v.is_integer() else v


def check_overflow(results, node, parent, top_level_id, require_clip=True):
    p_styles = parent.get('styles', {})
    p_clips = p_styles.get('clipsContent', False) or parent.get('clipsContent', False)
    if (not require_clip or p_clips) and 'bounds' in node and 'bounds' in parent:
        nb = node.get('bounds', {})
        pb = parent.get('bounds', {})
        x = nb.get('x', 0)
        y = nb.get('y', 0)
        w = nb.get('width', 0)
        h = nb.get('height', 0)
        pw = pb.get('width', 0)
        ph = pb.get('height', 0)

        ol = -x if x < -0.5 else 0.0
        ot = -y if y < -0.5 else 0.0
        oright = (x + w) - pw if (x + w) > pw + 0.5 else 0.0
        ob = (y + h) - ph if (y + h) > ph + 0.5 else 0.0

        if ol > 0 or ot > 0 or oright > 0 or ob > 0:
            results.append(
                {
                    'node_id': node.get('id'),
                    'type': node.get('type'),
                    'name': node.get('name'),
                    'parent_id': parent.get('id'),
                    'top_level_ancestor': top_level_id,
                    'overflow_left': format_val(ol),
                    'overflow_top': format_val(ot),
                    'overflow_right': format_val(oright),
                    'overflow_bottom': format_val(ob),
                }
            )


def precheck(root, mode):
    """The rows of one tree in one mode."""
    results = []

    if mode == 'default':

        def walk_default(node, parent=None, top_level_id=None):
            if parent:
                check_overflow(results, node, parent, top_level_id, require_clip=True)
            for child in node.get('children', []):
                tl_id = child.get('id') if node.get('type') == 'PAGE' else top_level_id
                walk_default(child, node, tl_id)

        walk_default(root)

    elif mode == 'all':
        # 1. Any child escaping any parent, whether or not the parent clips
        def walk_all(node, parent=None, top_level_id=None):
            if parent:
                check_overflow(results, node, parent, top_level_id, require_clip=False)

            # 2. Siblings at identical coordinates under any parent
            children = node.get('children', [])
            coords_map = defaultdict(list)
            for c in children:
                if 'bounds' in c:
                    cb = c['bounds']
                    key = (round(cb.get('x', 0), 2), round(cb.get('y', 0), 2))
                    coords_map[key].append(c)

            for key, sibs in coords_map.items():
                if len(sibs) > 1:
                    for s in sibs:
                        results.append(
                            {
                                'node_id': s.get('id'),
                                'type': s.get('type'),
                                'name': s.get('name'),
                                'parent_id': node.get('id'),
                                'top_level_ancestor': top_level_id,
                                'overflow_left': 'IDENTICAL_COORDS',
                                'overflow_top': f'x={key[0]}',
                                'overflow_right': f'y={key[1]}',
                                'overflow_bottom': f'count={len(sibs)}',
                            }
                        )

            for child in children:
                tl_id = child.get('id') if node.get('type') == 'PAGE' else top_level_id
                walk_all(child, node, tl_id)

        walk_all(root)

        # 3. Top-level page children that overlap
        if root.get('type') == 'PAGE':
            top_children = root.get('children', [])
            for i in range(len(top_children)):
                c1 = top_children[i]
                b1 = c1.get('bounds', {})
                if not b1:
                    continue
                x1, y1, w1, h1 = b1.get('x', 0), b1.get('y', 0), b1.get('width', 0), b1.get('height', 0)
                for j in range(i + 1, len(top_children)):
                    c2 = top_children[j]
                    b2 = c2.get('bounds', {})
                    if not b2:
                        continue
                    x2, y2, w2, h2 = b2.get('x', 0), b2.get('y', 0), b2.get('width', 0), b2.get('height', 0)
                    # Check overlap with 0.5px tolerance
                    overlap = x1 < x2 + w2 - 0.5 and x1 + w1 > x2 + 0.5 and y1 < y2 + h2 - 0.5 and y1 + h1 > y2 + 0.5
                    if overlap:
                        results.append(
                            {
                                'node_id': c1.get('id'),
                                'type': c1.get('type'),
                                'name': c1.get('name'),
                                'parent_id': root.get('id'),
                                'top_level_ancestor': c1.get('id'),
                                'overflow_left': 'PAGE_CHILD_OVERLAP',
                                'overflow_top': f"with={c2.get('id')}",
                                'overflow_right': 0,
                                'overflow_bottom': 0,
                            }
                        )
    return results


def hidden_rows(dump, mode, visible_rows):
    """The rows of the whole dump that the visible rows do not hold, or None without hidden content."""
    if not dump.has_hidden_content:
        return None
    seen = {tuple(row[f] for f in FIELDNAMES) for row in visible_rows}
    return [row for row in precheck(dump.root, mode) if tuple(row[f] for f in FIELDNAMES) not in seen]


def figures(dump, mode):
    """The row counts of one root, for the self-check."""
    rows = precheck(dump.visible(), mode)
    hidden = hidden_rows(dump, mode, rows)
    return {'rows': len(rows), 'hidden_rows': None if hidden is None else len(hidden)}


def main():
    parser = argparse.ArgumentParser(description='Check for clipped content overflow or all surface defects')
    parser.add_argument('dump', type=str, help='A dump folder, a file in one, or a baseline file')
    cli.add_dump_options(parser)
    parser.add_argument(
        '--mode',
        choices=['default', 'all'],
        default='default',
        help='default: clipped parents only; all: unclipped escaping, identical siblings, overlapping top-level',
    )
    parser.add_argument('--label', default=None, help='The output file name, without .csv')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    outputs = OutputDir(args.outputs, args.fixtures)
    dump = load_dump(args.dump, args.root, args.format)
    label = args.label or f'precheck_{args.mode}_{dump.node_id.replace(":", "_")}'

    results = precheck(dump.visible(), args.mode)
    out_path = outputs.write_csv(f'{label}.csv', FIELDNAMES, results)
    print(f'sr_precheck ({args.mode}): found {len(results)} rows. Written to {out_path}')

    hidden = hidden_rows(dump, args.mode, results)
    if hidden is not None:
        hidden_path = outputs.write_csv(f'{label}.hidden.csv', FIELDNAMES, hidden)
        print(f'sr_precheck ({args.mode}): {len(hidden)} more rows with the hidden content. Written to {hidden_path}')
    elif dump.format == FORMAT_DUMP_NODES:
        print('sr_precheck: the hidden content was not dumped (includeHidden was false); not audit evidence.')
    return cli.EXIT_OK


if __name__ == '__main__':
    cli.run(main)
