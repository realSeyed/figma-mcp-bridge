#!/usr/bin/env python3
"""selfcheck.py — run each known answer of the fixtures, and the fingerprint of the baseline.

    python tools/audit/selfcheck.py --fixtures <folder> --outputs <folder>

It reads `<fixtures>/expected.json`, and only from there the expected values.
For each fingerprint it compares the SHA-256 of a fixture file with the
expected value; a truncated expected value matches as a prefix. For each known
answer it runs the figures of one script on the fixture inputs and compares
each named figure. It prints one line for each check, `PASS` or `FAIL`, with
the name, the observed value, and the expected value, and a result line at the
end. It writes `selfcheck.txt` and `selfcheck.json` to the outputs folder.

Exit codes: 0 when each check passes, 1 at a mismatch, 2 when an input is
missing or `expected.json` is not usable. The format of `expected.json` is in
`tools/audit/README.md`.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import census  # noqa: E402
import completeness  # noqa: E402
import contrast  # noqa: E402
import sr_precheck  # noqa: E402
from auditlib import cli  # noqa: E402
from auditlib.config import AuditConfig, parse_config  # noqa: E402
from auditlib.dumps import load_dump, load_json, load_variables  # noqa: E402
from auditlib.manifest import canonical_sha256, sha256_file  # noqa: E402
from auditlib.outputs import EXPECTED_NAME, OutputDir  # noqa: E402

MATCHES = ('exact', 'unordered', 'subset', 'prefix')
FORMS = ('bytes', 'canonical')
SCRIPTS = ('census', 'contrast', 'sr_precheck', 'completeness')
MIN_PREFIX = 8


class ExpectedError(Exception):
    """`expected.json` is missing, or it does not have the format of the self-check."""


class Checks:
    """The lines and the results of one run."""

    def __init__(self):
        self.lines = []
        self.results = []
        self.failed = 0
        self.input_errors = 0

    def add(self, ok, name, observed, expected, input_error=False):
        status = 'PASS' if ok else 'FAIL'
        self.lines.append(f'{status} {name} observed={_show(observed)} expected={_show(expected)}')
        self.results.append({'status': status, 'name': name, 'observed': observed, 'expected': expected})
        if not ok:
            self.failed += 1
        if input_error:
            self.input_errors += 1


def _show(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


# ── Comparison ───────────────────────────────────────────────────────


def strict_equal(a, b):
    """JSON equality that keeps a boolean apart from a number."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(strict_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(strict_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def subset_equal(observed, expected):
    """Each key of an expected object is in the observed object, with a value that matches in the same way."""
    if isinstance(expected, dict):
        return isinstance(observed, dict) and all(
            key in observed and subset_equal(observed[key], value) for key, value in expected.items()
        )
    return strict_equal(observed, expected)


def matches(observed, expected, match):
    if match == 'exact':
        return strict_equal(observed, expected)
    if match == 'subset':
        return subset_equal(observed, expected)
    if match == 'unordered':
        if not isinstance(observed, list) or not isinstance(expected, list):
            return False
        return strict_equal(sorted(observed, key=_show), sorted(expected, key=_show))
    if match == 'prefix':
        return (
            isinstance(observed, str)
            and isinstance(expected, str)
            and len(expected) >= MIN_PREFIX
            and observed.lower().startswith(expected.lower())
        )
    raise ExpectedError(f'the match {match!r} is not known; use one of {", ".join(MATCHES)}.')


def figure_at(figures, path):
    """The value at a dotted path. A key that holds a dot, such as `12.5`, still matches."""
    current = figures
    remaining = path.split('.')
    while remaining:
        if not isinstance(current, dict):
            raise KeyError(path)
        for n in range(len(remaining), 0, -1):
            key = '.'.join(remaining[:n])
            if key in current:
                current = current[key]
                remaining = remaining[n:]
                break
        else:
            raise KeyError(path)
    return json.loads(json.dumps(current))


# ── expected.json ────────────────────────────────────────────────────


def read_expected(fixtures):
    path = fixtures / EXPECTED_NAME
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise ExpectedError(f'{path} is missing.') from None
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ExpectedError(f'{path} is not valid JSON: {err}') from None
    if not isinstance(data, dict):
        raise ExpectedError(f'{path} must hold a JSON object.')
    if not isinstance(data.get('fingerprints'), list) or not data['fingerprints']:
        raise ExpectedError(
            f'{path} has no "fingerprints" list, so the fingerprint of the baseline get_variable_defs '
            'dump cannot be checked. See tools/audit/README.md.'
        )
    known = data.get('known_answers')
    if isinstance(known, dict):
        raise ExpectedError(
            f'{path} holds "known_answers" as an object, the form of the earlier scripts. Write it as a list '
            'of known answers; see tools/audit/README.md.'
        )
    if not isinstance(known, list) or not known:
        raise ExpectedError(f'{path} has no "known_answers" list. See tools/audit/README.md.')
    return data


def read_config(fixtures, data):
    config = data.get('config')
    if config is None:
        return AuditConfig()
    if isinstance(config, str):
        return parse_config(load_json(fixtures / config), str(fixtures / config))
    return parse_config(config, f'{fixtures / EXPECTED_NAME}: "config"')


def _input_path(fixtures, value, key):
    if not isinstance(value, str) or not value:
        raise cli.InputError(f'the input "{key}" must be a path.')
    return fixtures / value


def _dump_spec(fixtures, spec, inputs, key):
    """A dump from `"path"` or `{"path", "root", "format"}`; the root and format may also sit beside it."""
    if isinstance(spec, dict):
        path, root, form = spec.get('path'), spec.get('root'), spec.get('format')
    else:
        path, root, form = spec, inputs.get('root'), inputs.get('format')
    return load_dump(_input_path(fixtures, path, key), root, form)


def run_script(fixtures, script, inputs, config):
    """The figures of one script on the inputs of a known answer."""
    if not isinstance(inputs, dict):
        raise cli.InputError('"inputs" must be an object.')
    if script == 'census':
        return census.figures(
            _dump_spec(fixtures, inputs.get('dump'), inputs, 'dump'),
            load_variables(_input_path(fixtures, inputs.get('variables'), 'variables')),
            load_json(_input_path(fixtures, inputs.get('exemptions'), 'exemptions')),
            config,
        )
    if script == 'contrast':
        specs = inputs.get('dumps', [inputs['dump']] if 'dump' in inputs else None)
        if not isinstance(specs, list) or not specs:
            raise cli.InputError('contrast needs "dumps", a list of dumps, or "dump".')
        dumps = [_dump_spec(fixtures, spec, {}, 'dumps') for spec in specs]
        return contrast.figures(
            dumps,
            load_variables(_input_path(fixtures, inputs.get('variables'), 'variables')),
            config,
            context_base=inputs.get('context_base'),
            scope=inputs.get('scope'),
        )
    if script == 'sr_precheck':
        mode = inputs.get('mode', 'default')
        if mode not in ('default', 'all'):
            raise cli.InputError('sr_precheck takes the mode "default" or "all".')
        return sr_precheck.figures(_dump_spec(fixtures, inputs.get('dump'), inputs, 'dump'), mode)
    if script == 'completeness':
        components = inputs.get('components')
        counts = inputs.get('page_child_counts')
        return completeness.figures(
            _dump_spec(fixtures, inputs.get('dump'), inputs, 'dump'),
            load_json(_input_path(fixtures, components, 'components')) if components is not None else None,
            load_json(_input_path(fixtures, counts, 'page_child_counts')) if counts is not None else None,
        )
    raise ExpectedError(f'the script {script!r} is not known; use one of {", ".join(SCRIPTS)}.')


# ── The run ──────────────────────────────────────────────────────────


def check_fingerprints(checks, fixtures, data):
    for index, entry in enumerate(data['fingerprints']):
        if not isinstance(entry, dict):
            raise ExpectedError(f'fingerprints[{index}] is not an object.')
        name = f'fingerprint {entry.get("name", index)}'
        expected = entry.get('sha256')
        form = entry.get('form', 'bytes')
        if form not in FORMS:
            raise ExpectedError(f'fingerprints[{index}]: the form {form!r} is not known; use bytes or canonical.')
        if not isinstance(expected, str) or len(expected) < MIN_PREFIX:
            checks.add(False, name, None, expected, input_error=True)
            checks.lines[-1] += f' (the expected sha256 needs {MIN_PREFIX} hexadecimal characters at least)'
            continue
        try:
            path = _input_path(fixtures, entry.get('path'), 'path')
            observed = sha256_file(path) if form == 'bytes' else canonical_sha256(load_json(path))
        except (OSError, *cli.INPUT_ERRORS) as err:
            checks.add(False, name, f'error: {err}', expected, input_error=True)
            continue
        checks.add(matches(observed, expected, 'prefix'), name, observed, expected)


def check_known_answers(checks, fixtures, data, config):
    cache = {}
    for index, entry in enumerate(data['known_answers']):
        if not isinstance(entry, dict):
            raise ExpectedError(f'known_answers[{index}] is not an object.')
        name = entry.get('name', f'known_answers[{index}]')
        match = entry.get('match', 'exact')
        if match not in MATCHES:
            raise ExpectedError(f'{name}: the match {match!r} is not known; use one of {", ".join(MATCHES)}.')
        if 'figures' in entry:
            wanted = entry['figures']
            if not isinstance(wanted, dict) or not wanted:
                raise ExpectedError(f'{name}: "figures" must be an object of figure path to expected value.')
        elif 'figure' in entry and 'expected' in entry:
            wanted = {entry['figure']: entry['expected']}
        else:
            raise ExpectedError(f'{name}: give "figure" and "expected", or "figures".')

        script = entry.get('script')
        key = json.dumps([script, entry.get('inputs')], sort_keys=True)
        if key not in cache:
            try:
                cache[key] = (run_script(fixtures, script, entry.get('inputs'), config), None)
            except (OSError, *cli.INPUT_ERRORS) as err:
                cache[key] = (None, err)
        result, error = cache[key]
        for figure, expected in wanted.items():
            label = f'{name} {figure}'
            if error is not None:
                checks.add(False, label, f'error: {error}', expected, input_error=True)
                continue
            try:
                observed = figure_at(result, figure)
            except KeyError:
                checks.add(False, label, 'error: the script has no such figure', expected, input_error=True)
                continue
            checks.add(matches(observed, expected, match), label, observed, expected)


def main():
    parser = argparse.ArgumentParser(description='Run the known answers of the fixtures')
    parser.add_argument('--fixtures', required=True, help='The fixtures folder with expected.json')
    parser.add_argument('--outputs', required=True, help='The outputs folder, outside the fixtures folder')
    args = parser.parse_args()

    fixtures = Path(args.fixtures).resolve()
    outputs = OutputDir(args.outputs, fixtures)
    checks = Checks()
    try:
        data = read_expected(fixtures)
        config = read_config(fixtures, data)
        check_fingerprints(checks, fixtures, data)
        check_known_answers(checks, fixtures, data, config)
    except (ExpectedError, *cli.INPUT_ERRORS) as err:
        checks.add(False, EXPECTED_NAME, f'error: {err}', 'the format of tools/audit/README.md', input_error=True)

    total = len(checks.results)
    ok = checks.failed == 0
    summary = f'SELFCHECK {"PASS" if ok else "FAIL"} checks={total}' + ('' if ok else f' failed={checks.failed}')
    for line in checks.lines + [summary]:
        print(line)
    outputs.write_text('selfcheck.txt', '\n'.join(checks.lines + [summary]) + '\n')
    outputs.write_json('selfcheck.json', {'results': checks.results, 'summary': summary})
    if checks.input_errors:
        return cli.EXIT_INPUT
    return cli.EXIT_OK if ok else cli.EXIT_FAILED


if __name__ == '__main__':
    cli.run(main)
