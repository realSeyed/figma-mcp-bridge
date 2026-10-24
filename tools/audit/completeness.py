#!/usr/bin/env python3
"""completeness.py — the completeness checks of a dump.

- Set completeness: for a dumped component set, the variants in the dump
  against the `variantCount` that `list_components` reported. It fails when
  they differ.
- Page completeness: the children of a dumped page against a list of page
  child counts.
- Nested shortfalls: each node that carries fewer children than its
  `childCount`, the mark of a cut `get_node` read. A `dump_nodes` dump is
  never cut, so it has none.

A `dump_nodes` dump counts each child, the hidden ones included: Figma counts
a hidden variant in `variantCount`, and a page counts its hidden children.
The `hidden` field gives how many of them are hidden. A baseline dump holds
no hidden content, so there `hidden` is null.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.dumps import children_of, is_hidden_node, load_all_roots, load_json  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402

SOURCE_LISTING = 'list_components'
SOURCE_PAGE_COUNTS = 'page_child_counts'
SOURCE_CHILD_COUNT = 'childCount'
SOURCE_CARRIED = 'carried'
SOURCE_MISSING = 'missing'


def check_node_completeness(node):
    """Each node whose children differ from its `childCount`, as id to `{carried, expected}`."""
    shortfalls = {}

    def walk(n):
        children = n.get('children', [])
        cc = n.get('childCount')
        if cc is not None and len(children) != cc:
            shortfalls[n['id']] = {'carried': len(children), 'expected': cc}
        for c in children:
            walk(c)

    walk(node)
    return shortfalls


def _hidden_children(dump):
    if not dump.has_hidden_content:
        return None
    return sum(1 for child in children_of(dump.root) if is_hidden_node(child))


def check_page_completeness(dump, page_child_counts):
    """The children of a page against its count. A page that the counts do not list expects 0."""
    root = dump.root
    carried = len(root.get('children', []))
    counts = _page_counts(page_child_counts)
    if root.get('id') in counts:
        expected, source = counts[root['id']], SOURCE_PAGE_COUNTS
    else:
        expected, source = 0, SOURCE_MISSING
    return {
        'result': 'PASS' if carried == expected else 'FAIL',
        'carried': carried,
        'expected': expected,
        'expected_source': source,
        'hidden': _hidden_children(dump),
    }


def _page_counts(data):
    """Page ID to child count, from a list of `{id, child_count}` or an object of ID to count."""
    if isinstance(data, dict):
        return {key: value for key, value in data.items() if isinstance(value, int)}
    if isinstance(data, list):
        return {p['id']: p['child_count'] for p in data if isinstance(p, dict) and 'id' in p and 'child_count' in p}
    return {}


def check_set_completeness(dump, comp_info):
    """The variants of a dumped set against the count that `list_components` or `get_component` gave.

    `comp_info` is a `list_components` result (`items`) or a `get_component`
    result (`variantCount`). When it gives no count for the set, the expected
    value is the `childCount` of the root, else the carried count, as in the
    census of the earlier scripts; `expected_source` then says so.
    """
    root = dump.root
    carried = len(root.get('children', []))
    expected = None
    source = None
    if isinstance(comp_info, dict):
        if 'variantCount' in comp_info:
            expected, source = comp_info['variantCount'], SOURCE_LISTING
        elif 'items' in comp_info:
            for item in comp_info['items']:
                if item.get('id') == root.get('id'):
                    expected, source = item.get('variantCount'), SOURCE_LISTING
                    break
    if expected is None:
        if 'childCount' in root:
            expected, source = root['childCount'], SOURCE_CHILD_COUNT
        else:
            expected, source = carried, SOURCE_CARRIED
    return {
        'result': 'PASS' if carried == expected else 'FAIL',
        'carried': carried,
        'expected': expected,
        'expected_source': source,
        'hidden': _hidden_children(dump),
    }


def figures(dump, components=None, page_child_counts=None):
    """The completeness figures of one root, for the self-check."""
    root_type = dump.root.get('type')
    return {
        'set_completeness': (
            check_set_completeness(dump, components) if root_type == 'COMPONENT_SET' and components is not None else None
        ),
        'page_completeness': (
            check_page_completeness(dump, page_child_counts)
            if root_type == 'PAGE' and page_child_counts is not None
            else None
        ),
        'nested_shortfalls': check_node_completeness(dump.root),
    }


def verdict(check, listed_source):
    """PASS, FAIL, or UNCHECKED when no listing gave the expected count."""
    if check['result'] == 'FAIL':
        return 'FAIL'
    return 'PASS' if check['expected_source'] == listed_source else 'UNCHECKED'


def main():
    parser = argparse.ArgumentParser(description='Completeness checks of dumps')
    parser.add_argument('dumps', nargs='+', help='Dump folders or files; each root of a folder is checked.')
    parser.add_argument('--components', default=None, help='A saved list_components or get_component result.')
    parser.add_argument('--page-child-counts', default=None, help='A list of {id, child_count} for each page.')
    parser.add_argument(
        '--format', choices=['baseline', 'dump_nodes'], default=None, help='Force the format of each dump.'
    )
    parser.add_argument('--label', default='completeness', help='The name of the output file, without .json.')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    outputs = OutputDir(args.outputs, args.fixtures)
    components = load_json(args.components) if args.components else None
    page_counts = load_json(args.page_child_counts) if args.page_child_counts else None

    results = []
    lines = []
    worst = cli.EXIT_OK
    for path in args.dumps:
        for dump in load_all_roots(path, args.format):
            result = {'root_id': dump.node_id, 'root_type': dump.root.get('type'), 'source': dump.source()}
            result.update(figures(dump, components, page_counts))
            checks = []
            if result['set_completeness'] is not None:
                checks.append(('set', result['set_completeness'], SOURCE_LISTING))
            elif dump.root.get('type') == 'COMPONENT_SET':
                lines.append(f'UNCHECKED set {dump.node_id}: give --components to compare its variants.')
                worst = cli.EXIT_FAILED
            if result['page_completeness'] is not None:
                checks.append(('page', result['page_completeness'], SOURCE_PAGE_COUNTS))
            for kind, check, listed in checks:
                status = verdict(check, listed)
                hidden = '' if check['hidden'] is None else f' hidden={check["hidden"]}'
                lines.append(
                    f'{status} {kind} {dump.node_id} carried={check["carried"]} expected={check["expected"]} '
                    f'source={check["expected_source"]}{hidden}'
                )
                result[f'{kind}_verdict'] = status
                if status != 'PASS':
                    worst = cli.EXIT_FAILED
            for node_id, shortfall in result['nested_shortfalls'].items():
                lines.append(
                    f'FAIL nested {node_id} carried={shortfall["carried"]} expected={shortfall["expected"]}'
                )
                worst = cli.EXIT_FAILED
            results.append(result)

    outputs.write_json(f'{args.label}.json', results)
    for line in lines:
        print(line)
    print(f'completeness: {len(results)} roots, {"PASS" if worst == cli.EXIT_OK else "FAIL"}')
    return worst


if __name__ == '__main__':
    cli.run(main)
