#!/usr/bin/env python3
"""assert.py — the checks runner: evaluates the checks file of a milestone against a dump.

A checks file is a JSON array. Each row is one check:

    { "id": "C-1", "node": "12:34", "field": "styles.fills[0].color", "op": "eq", "expected": "#ffffff" }
    { "id": "C-2", "node": "12:35", "measure": "variantCount", "op": "ge", "expected": 4 }
    { "id": "C-3", "node": "12:36", "measure": "contrastRatio", "op": "approx", "expected": 4.5, "tolerance": 0.05 }

`field` is a path into the node of the dump (`auditlib/paths.py`); `measure` is
a derived figure (see `MEASURES`). A check has one of them. The runner reads
the full tree of the dump, hidden content included, so a check can address a
hidden node.

Exit codes: 0 when each check passes, 1 when a check fails, 2 when an input is
wrong (an unknown node, an unknown operator, a bad path, a bad row) or does
not match its manifest. An input error stops the run before anything is
written.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.config import load_config  # noqa: E402
from auditlib.dumps import (  # noqa: E402
    children_of,
    index_nodes,
    is_hidden_node,
    load_all_roots,
    load_dump,
    load_json,
    load_variables,
)
from auditlib.manifest import sha256_file  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402
from auditlib.paths import ABSENT, PathError, parse_path, resolve, values_equal  # noqa: E402

OPERATORS = ('eq', 'ne', 'lt', 'le', 'gt', 'ge', 'approx', 'in', 'contains', 'exists', 'absent', 'matches')
NUMERIC_OPERATORS = ('lt', 'le', 'gt', 'ge')
NO_EXPECTED = ('exists', 'absent')
MEASURES = ('childCount', 'visibleChildCount', 'variantCount', 'boundVariable', 'contrastRatio')
ROW_KEYS = {'id', 'node', 'field', 'measure', 'op', 'expected', 'tolerance', 'comment'}
SHOWN_WIDTH = 48

_MEASURE = re.compile(r'([A-Za-z]+)(?:\((.*)\))?', re.DOTALL)


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# ── The checks file ──────────────────────────────────────────────────


class Check:
    """One validated row of the checks file."""

    def __init__(self, index, row):
        self.index = index
        self.row = row
        self.id = row['id']
        self.node = row['node']
        self.op = row['op']
        self.expected = row.get('expected')
        self.tolerance = row.get('tolerance')
        self.field = row.get('field')
        self.measure = row.get('measure')
        self.steps = None
        self.measure_name = None
        self.measure_arg = None
        self.regex = None

    @property
    def subject(self):
        return self.field if self.field is not None else self.measure


def read_checks(path):
    """Reads and validates the checks file. Raises `cli.InputError` that lists each bad row."""
    data = load_json(path)
    if not isinstance(data, list) or not data:
        raise cli.InputError(f'{path}: the checks file must be a JSON array with at least one check.')
    problems = []
    checks = []
    seen = {}
    for index, row in enumerate(data):
        found = _validate_row(index, row, seen)
        if isinstance(found, Check):
            checks.append(found)
        else:
            problems += found
    if problems:
        raise cli.InputError(f'{path}: the checks file has errors:\n' + '\n'.join(problems))
    return checks


def _validate_row(index, row, seen):
    at = f'checks[{index}]'
    if not isinstance(row, dict):
        return [f'{at}: the row is not an object.']
    problems = []
    unknown = sorted(set(row) - ROW_KEYS)
    if unknown:
        problems.append(f'{at}: unknown key {", ".join(unknown)}. Keys: {", ".join(sorted(ROW_KEYS))}.')
    for key in ('id', 'node', 'op'):
        if not isinstance(row.get(key), str) or row.get(key) == '':
            problems.append(f'{at}: {key} must be a non-empty string.')
    if isinstance(row.get('id'), str) and row['id']:
        if row['id'] in seen:
            problems.append(f'{at}: the id {row["id"]} is also the id of checks[{seen[row["id"]]}].')
        seen.setdefault(row['id'], index)
    has_field, has_measure = 'field' in row, 'measure' in row
    if has_field == has_measure:
        problems.append(f'{at}: give exactly one of field and measure.')
    op = row.get('op')
    if isinstance(op, str) and op and op not in OPERATORS:
        problems.append(f'{at}: the operator {op!r} is not known. Operators: {", ".join(OPERATORS)}.')
    if problems:
        return problems

    check = Check(index, row)
    if has_field:
        try:
            check.steps = parse_path(row['field'])
        except (PathError, TypeError) as err:
            return [f'{at}: field: {err}']
    else:
        problems += _validate_measure(at, check)
    problems += _validate_operands(at, check)
    return problems or check


def _validate_measure(at, check):
    text = check.measure
    match = _MEASURE.fullmatch(text) if isinstance(text, str) else None
    if match is None or match.group(1) not in MEASURES:
        return [f'{at}: the measure {text!r} is not known. Measures: {", ".join(MEASURES)}.']
    name, arg = match.group(1), match.group(2)
    check.measure_name = name
    if name == 'boundVariable':
        if not arg:
            return [f'{at}: boundVariable needs a field, as in boundVariable(fills[0]).']
        try:
            check.measure_arg = parse_path(arg)
        except PathError as err:
            return [f'{at}: measure: {err}']
    elif arg is not None:
        return [f'{at}: the measure {name} takes no argument.']
    return []


def _validate_operands(at, check):
    problems = []
    op, expected, row = check.op, check.expected, check.row
    if op in NO_EXPECTED:
        if 'expected' in row:
            problems.append(f'{at}: the operator {op} takes no expected value.')
    elif 'expected' not in row:
        problems.append(f'{at}: the operator {op} needs expected.')
    elif op in NUMERIC_OPERATORS and not _number(expected):
        problems.append(f'{at}: the operator {op} needs a number in expected.')
    elif op == 'approx' and not _number(expected):
        problems.append(f'{at}: the operator approx needs a number in expected.')
    elif op == 'in' and not isinstance(expected, list):
        problems.append(f'{at}: the operator in needs a list in expected.')
    elif op == 'matches':
        if not isinstance(expected, str):
            problems.append(f'{at}: the operator matches needs a regular expression in expected.')
        else:
            try:
                check.regex = re.compile(expected)
            except re.error as err:
                problems.append(f'{at}: expected is not a regular expression: {err}.')
    if op == 'approx':
        if not _number(check.tolerance) or check.tolerance < 0:
            problems.append(f'{at}: the operator approx needs tolerance, a number of 0 or more.')
    elif 'tolerance' in row:
        problems.append(f'{at}: tolerance belongs to the operator approx only.')
    return problems


# ── The nodes ────────────────────────────────────────────────────────


class Nodes:
    """The nodes of the roots of a dump, by ID, and the measures over them."""

    def __init__(self, dumps, resolver=None, context_bg_hex=None, disabled_variant=None):
        self.dumps = dumps
        self.by_id = {}
        for position, dump in enumerate(dumps):
            for node_id, (node, _parent) in index_nodes(dump.root).items():
                self.by_id.setdefault(node_id, (node, position))
        self._resolver = resolver
        self._context_bg_hex = context_bg_hex
        self._disabled_variant = disabled_variant
        self._ratios = {}

    def get(self, node_id):
        found = self.by_id.get(node_id)
        return None if found is None else found[0]

    def field(self, node_id, steps):
        return resolve(self.get(node_id), steps)

    def measure(self, node_id, check):
        node = self.get(node_id)
        name = check.measure_name
        if name == 'childCount':
            return len(children_of(node))
        if name == 'visibleChildCount':
            return sum(1 for child in children_of(node) if not is_hidden_node(child))
        if name == 'variantCount':
            if node.get('type') != 'COMPONENT_SET':
                raise cli.InputError(
                    f'checks[{check.index}]: variantCount needs a COMPONENT_SET, but {node_id} is a '
                    f'{node.get("type")}. Use the id of a component set.'
                )
            return sum(1 for child in children_of(node) if child.get('type') == 'COMPONENT')
        if name == 'boundVariable':
            return _binding(resolve(node.get('boundVariables'), check.measure_arg))
        return self._contrast_ratio(node_id)

    def _contrast_ratio(self, node_id):
        position = self.by_id[node_id][1]
        if position not in self._ratios:
            import contrast

            dump = self.dumps[position]
            pairs, _not_computed, _hidden = contrast.audit_tree(
                dump.name, dump.visible(), self._resolver, self._context_bg_hex, self._disabled_variant
            )
            self._ratios[position] = {pair['node_id']: float(pair['ratio']) for pair in pairs}
        return self._ratios[position].get(node_id, ABSENT)


def _binding(value):
    """The variable ID of a binding: the entry as a string, or the `id` of an alias object."""
    if isinstance(value, dict) and 'id' in value:
        return value['id']
    if isinstance(value, list):
        return [_binding(item) for item in value]
    return value


# ── The operators ────────────────────────────────────────────────────


def evaluate(check, observed):
    """True when the check passes. `observed` is `ABSENT` when the value is not there."""
    present = observed is not ABSENT and observed is not None
    if check.op == 'absent':
        return not present
    if not present:
        return False
    if check.op == 'exists':
        return True
    op, expected = check.op, check.expected
    if op == 'eq':
        return values_equal(observed, expected)
    if op == 'ne':
        return not values_equal(observed, expected)
    if op in NUMERIC_OPERATORS or op == 'approx':
        if not _number(observed):
            return False
        if op == 'approx':
            return abs(observed - expected) <= check.tolerance
        if op == 'lt':
            return observed < expected
        if op == 'le':
            return observed <= expected
        if op == 'gt':
            return observed > expected
        return observed >= expected
    if op == 'in':
        return any(values_equal(observed, item) for item in expected)
    if op == 'contains':
        if isinstance(observed, str):
            return isinstance(expected, str) and expected in observed
        if isinstance(observed, list):
            return any(values_equal(item, expected) for item in observed)
        if isinstance(observed, dict):
            return isinstance(expected, str) and expected in observed
        return False
    return isinstance(observed, str) and check.regex.search(observed) is not None


def run_checks(checks, nodes):
    """Evaluates each check; unknown nodes and measure errors raise before any result is returned."""
    unknown = [
        f'checks[{check.index}]: the node {check.node} is not in the dump.'
        for check in checks
        if nodes.get(check.node) is None
    ]
    if unknown:
        raise cli.InputError('the checks name nodes that the dump does not hold:\n' + '\n'.join(unknown))
    results = []
    for check in checks:
        if check.field is not None:
            observed = nodes.field(check.node, check.steps)
        else:
            observed = nodes.measure(check.node, check)
        passed = evaluate(check, observed)
        present = observed is not ABSENT
        row = {
            'id': check.id,
            'node': check.node,
            'op': check.op,
            'expected': check.expected if check.op not in NO_EXPECTED else None,
            'observed': observed if present else None,
            'present': present and observed is not None,
            'result': 'PASS' if passed else 'FAIL',
        }
        row = {('field' if check.field is not None else 'measure'): check.subject, **row}
        if check.op == 'approx':
            row['tolerance'] = check.tolerance
        if 'comment' in check.row:
            row['comment'] = check.row['comment']
        results.append(row)
    return results


# ── The output ───────────────────────────────────────────────────────


def _shown(value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return text if len(text) <= SHOWN_WIDTH else text[: SHOWN_WIDTH - 1] + '…'


def render_table(results):
    header = ['ID', 'NODE', 'FIELD/MEASURE', 'OP', 'EXPECTED', 'OBSERVED', 'RESULT']
    rows = [header]
    for r in results:
        subject = r.get('field', r.get('measure'))
        expected = '-' if r['op'] in NO_EXPECTED else _shown(r['expected'])
        observed = _shown(r['observed']) if r['present'] else '(absent)'
        rows.append([r['id'], r['node'], subject, r['op'], expected, observed, r['result']])
    widths = [max(len(row[i]) for row in rows) for i in range(len(header))]
    return '\n'.join('  '.join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows)


def main():
    parser = argparse.ArgumentParser(description='Evaluate the checks file of a milestone against a dump')
    parser.add_argument('checks', help='The checks file: a JSON array of checks')
    parser.add_argument('dump', help='A dump folder, a file in one, or a baseline file')
    cli.add_dump_options(parser)
    parser.add_argument('--vars', default=None, help='A get_variable_defs payload; the measure contrastRatio needs it')
    parser.add_argument('--config', default=None, help='The configuration; the measure contrastRatio needs context_base')
    parser.add_argument('--label', default=None, help='The name prefix of the output files')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    outputs = OutputDir(args.outputs, args.fixtures)
    checks = read_checks(args.checks)
    dumps = [load_dump(args.dump, args.root, args.format)] if args.root else load_all_roots(args.dump, args.format)

    resolver = context_bg_hex = disabled_variant = None
    if any(check.measure_name == 'contrastRatio' for check in checks):
        if args.vars is None or args.config is None:
            raise cli.InputError('the measure contrastRatio needs --vars and --config.')
        import contrast

        config = load_config(args.config)
        resolver = contrast.VarResolver(load_variables(args.vars))
        context_bg_hex = contrast.resolve_context_base(resolver, config.require('context_base', 'assert.py'))
        disabled_variant = config.disabled_variant

    results = run_checks(checks, Nodes(dumps, resolver, context_bg_hex, disabled_variant))

    failed = sum(1 for r in results if r['result'] == 'FAIL')
    label = args.label or Path(args.checks).stem
    table = render_table(results)
    summary = {'checks': len(results), 'passed': len(results) - failed, 'failed': failed}
    outputs.write_json(
        f'{label}.assert.json',
        {
            'checksFile': {'path': str(args.checks), 'sha256': sha256_file(args.checks)},
            'sources': [dump.source() for dump in dumps],
            'summary': summary,
            'results': results,
        },
    )
    line = f'ASSERT {"FAIL" if failed else "PASS"} checks={summary["checks"]} failed={failed}'
    outputs.write_text(f'{label}.assert.txt', table + '\n\n' + line + '\n')
    print(table)
    print()
    print(line)
    return cli.EXIT_FAILED if failed else cli.EXIT_OK


if __name__ == '__main__':
    cli.run(main)
