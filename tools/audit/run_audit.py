#!/usr/bin/env python3
"""run_audit.py — reproduce each figure of an audit from the dumps of a package.

    python tools/audit/run_audit.py <package> --outputs <folder> [--allow-other-commit]

A package is a folder with `audit-package.json` (the layout is in
`tools/audit/README.md`). The run has five steps:

1. check each file of each manifest of the package against its SHA-256;
2. refuse a toolset commit that differs from the recorded one, unless
   `--allow-other-commit` is given;
3. run each script of the package on its dumps;
4. render the report;
5. compare each figure with the figure that the package recorded.

It writes only under the outputs folder: the outputs of each script under
`scripts/<id>/`, `report.md`, `run_audit.txt`, and `run_audit.json`. A script
always comes from this toolset, never from the package.

Exit codes: 0 when each recorded figure matches (or the package recorded none),
1 at a mismatch, 2 when an input is wrong: a file that does not match its
manifest, a toolset commit that differs, a package that does not follow the
layout.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render_report  # noqa: E402
import selfcheck  # noqa: E402
from auditlib import cli  # noqa: E402
from auditlib.config import AuditConfig, parse_config  # noqa: E402
from auditlib.dumps import load_json  # noqa: E402
from auditlib.manifest import load_manifest  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402
from auditlib.toolset import COMMIT, TOOLSET_DIR, toolset_commit  # noqa: E402

PACKAGE_FILE = 'audit-package.json'
SCHEMA = 1
TOP_KEYS = (
    'schema',
    'toolset_commit',
    'seeds',
    'config',
    'dump_calls',
    'capture_calls',
    'inputs',
    'runs',
    'acceptance',
    'recorded',
)
INPUT_FILES = ('surfaces', 'prescription_errors', 'defects')
RUN_KEYS = {
    'census': {'dump', 'root', 'format', 'variables', 'exemptions'},
    'contrast': {'dump', 'dumps', 'root', 'format', 'variables', 'context_base', 'scope'},
    'sr_precheck': {'dump', 'root', 'format', 'mode'},
    'completeness': {'dump', 'root', 'format', 'components', 'page_child_counts'},
    'tile': {'capture', 'manifest', 'tile_size', 'overlap'},
}
RUN_REQUIRED = {
    'census': ('dump', 'variables', 'exemptions'),
    'contrast': ('variables',),
    'sr_precheck': ('dump',),
    'completeness': ('dump',),
    'tile': ('capture',),
}
NEEDS_CONFIG = ('census', 'contrast')
PATH_KEYS = ('variables', 'exemptions', 'components', 'page_child_counts', 'capture', 'manifest')
ACCEPTANCE_KEYS = ('checks', 'dump', 'root', 'format', 'vars', 'label', 'figures', 'match')
RECORDED_KEYS = ('verdict',)
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*')


# ── The package ──────────────────────────────────────────────────────


class Package:
    """A package folder and its checked `audit-package.json`."""

    def __init__(self, root: Path, data: dict):
        self.root = root
        self.data = data

    def path(self, relative, where: str) -> Path:
        """The real path of a file or folder of the package. Raises when it leaves the package or is missing."""
        if not isinstance(relative, str) or not relative:
            raise cli.InputError(f'{where}: must be a path inside the package.')
        text = Path(relative)
        if text.is_absolute() or text.drive or '..' in text.parts:
            raise cli.InputError(f'{where}: "{relative}" must be a relative path inside the package, with no "..".')
        target = (self.root / text).resolve()
        try:
            target.relative_to(self.root)
        except ValueError:
            raise cli.InputError(f'{where}: "{relative}" leaves the package {self.root}.') from None
        if not target.exists():
            raise cli.InputError(f'{where}: "{relative}" is missing from the package.')
        return target


def _problems_for_calls(data, key, problems):
    calls = data.get(key, [])
    if not isinstance(calls, list):
        problems.append(f'{key}: must be a list.')
        return []
    seen = set()
    for index, call in enumerate(calls):
        at = f'{key}[{index}]'
        if not isinstance(call, dict) or set(call) != {'name', 'manifest'}:
            problems.append(f'{at}: must be an object with name and manifest.')
        elif not all(isinstance(call[k], str) and call[k] for k in ('name', 'manifest')):
            problems.append(f'{at}: name and manifest must be texts that are not empty.')
        elif call['name'] in seen:
            problems.append(f'{at}.name: "{call["name"]}" repeats an earlier call.')
        else:
            seen.add(call['name'])
    return calls


def _dump_specs(inputs):
    """The dump specs of the inputs of a run: a path, or `{ path, root, format }`."""
    specs = []
    if 'dump' in inputs:
        specs.append(('dump', inputs['dump']))
    if 'dumps' in inputs:
        if isinstance(inputs['dumps'], list):
            specs += [(f'dumps[{i}]', spec) for i, spec in enumerate(inputs['dumps'])]
        else:
            specs.append(('dumps', inputs['dumps']))
    return specs


def _check_run(package_data, index, run, problems):
    at = f'runs[{index}]'
    if not isinstance(run, dict):
        problems.append(f'{at}: must be an object.')
        return
    unknown = sorted(set(run) - {'id', 'script', 'inputs', 'figures', 'match'})
    if unknown:
        problems.append(f'{at}: unknown keys {", ".join(unknown)}. The keys are: id, script, inputs, figures, match.')
    if not (isinstance(run.get('id'), str) and NAME.fullmatch(run['id'])):
        problems.append(f'{at}.id: must be a name of letters, digits, ".", "_" and "-".')
    script = run.get('script')
    if script not in RUN_KEYS:
        problems.append(f'{at}.script: "{script}" is not known; use one of {", ".join(RUN_KEYS)}.')
        return
    inputs = run.get('inputs')
    if not isinstance(inputs, dict):
        problems.append(f'{at}.inputs: must be an object.')
        return
    unknown = sorted(set(inputs) - RUN_KEYS[script])
    if unknown:
        problems.append(f'{at}.inputs: unknown keys {", ".join(unknown)} for {script}. The keys are: {", ".join(sorted(RUN_KEYS[script]))}.')
    for key in RUN_REQUIRED[script]:
        if key not in inputs:
            problems.append(f'{at}.inputs.{key}: is required for {script}.')
    if script == 'contrast' and 'dump' not in inputs and 'dumps' not in inputs:
        problems.append(f'{at}.inputs: contrast needs dump or dumps.')
    if script in NEEDS_CONFIG and not isinstance(package_data.get('config'), str):
        problems.append(f'config: is required by {at} ({script}); give the path of the configuration file.')
    if 'figures' in run and (not isinstance(run['figures'], dict) or not run['figures']):
        problems.append(f'{at}.figures: must be an object of figure to recorded value.')
    if run.get('match', 'exact') not in selfcheck.MATCHES:
        problems.append(f'{at}.match: "{run.get("match")}" is not known; use one of {", ".join(selfcheck.MATCHES)}.')


def read_package(folder) -> Package:
    """Reads and checks `audit-package.json`. Every problem of the layout is listed in one error."""
    root = Path(folder).resolve()
    if not root.is_dir():
        raise cli.InputError(f'{folder}: the package must be a folder with {PACKAGE_FILE}.')
    data = load_json(root / PACKAGE_FILE)
    if not isinstance(data, dict):
        raise cli.InputError(f'{root / PACKAGE_FILE}: must hold a JSON object.')

    problems = []
    unknown = sorted(set(data) - set(TOP_KEYS))
    if unknown:
        problems.append(f'unknown keys {", ".join(unknown)}. The keys are: {", ".join(TOP_KEYS)}.')
    if data.get('schema') != SCHEMA:
        problems.append(f'schema: must be {SCHEMA}.')
    recorded_commit = data.get('toolset_commit')
    if not (isinstance(recorded_commit, str) and COMMIT.fullmatch(recorded_commit)):
        problems.append('toolset_commit: must be the full commit of 40 hexadecimal characters, with -dirty for an unclean tree.')
    if 'config' in data and not (isinstance(data['config'], str) and data['config']):
        problems.append('config: must be the path of the configuration file in the package.')
    if 'seeds' in data:
        try:
            render_report.check_seeds(data['seeds'], PACKAGE_FILE)
        except cli.InputError as err:
            problems.append(str(err).removeprefix(f'{PACKAGE_FILE}: '))
    dump_calls = _problems_for_calls(data, 'dump_calls', problems)
    capture_calls = _problems_for_calls(data, 'capture_calls', problems)
    if not dump_calls and not capture_calls:
        problems.append('dump_calls: the package needs at least one dump call or capture call.')

    inputs = data.get('inputs')
    if not isinstance(inputs, dict) or set(inputs) != set(INPUT_FILES):
        problems.append(f'inputs: must be an object with {", ".join(INPUT_FILES)}.')
    elif not all(isinstance(inputs[key], str) and inputs[key] for key in INPUT_FILES):
        problems.append('inputs: each value must be the path of a file in the package.')

    runs = data.get('runs', [])
    if not isinstance(runs, list):
        problems.append('runs: must be a list.')
        runs = []
    for index, run in enumerate(runs):
        _check_run(data, index, run, problems)
    ids = [run.get('id') for run in runs if isinstance(run, dict)]
    for run_id in sorted({i for i in ids if isinstance(i, str) and ids.count(i) > 1}):
        problems.append(f'runs: the id "{run_id}" is used more than once.')

    acceptance = data.get('acceptance')
    if not isinstance(acceptance, dict):
        problems.append('acceptance: is required; it names the checks file and the dump of the acceptance table.')
    else:
        unknown = sorted(set(acceptance) - set(ACCEPTANCE_KEYS))
        if unknown:
            problems.append(f'acceptance: unknown keys {", ".join(unknown)}. The keys are: {", ".join(ACCEPTANCE_KEYS)}.')
        for key in ('checks', 'dump'):
            if not (isinstance(acceptance.get(key), str) and acceptance[key]):
                problems.append(f'acceptance.{key}: is required, a path in the package.')
        label = acceptance.get('label', 'acceptance')
        if not (isinstance(label, str) and NAME.fullmatch(label)):
            problems.append('acceptance.label: must be a name of letters, digits, ".", "_" and "-".')
        if 'figures' in acceptance and (not isinstance(acceptance['figures'], dict) or not acceptance['figures']):
            problems.append('acceptance.figures: must be an object of figure to recorded value.')
        if acceptance.get('match', 'exact') not in selfcheck.MATCHES:
            problems.append(f'acceptance.match: must be one of {", ".join(selfcheck.MATCHES)}.')
    recorded = data.get('recorded', {})
    if not isinstance(recorded, dict) or sorted(set(recorded) - set(RECORDED_KEYS)):
        problems.append(f'recorded: must be an object with {", ".join(RECORDED_KEYS)} only.')
    elif recorded.get('verdict', 'PASS') not in ('PASS', 'FAIL'):
        problems.append('recorded.verdict: must be PASS or FAIL.')

    if problems:
        raise cli.InputError(f'{root / PACKAGE_FILE}:\n' + '\n'.join(problems))
    package = Package(root, data)
    _check_paths(package)
    return package


def _check_paths(package: Package) -> None:
    """Every path of the package is inside it and exists; every problem is listed."""
    data = package.data
    problems = []

    def check(relative, where):
        try:
            package.path(relative, where)
        except cli.InputError as err:
            problems.append(str(err))

    if 'config' in data:
        check(data['config'], 'config')
    for key in ('dump_calls', 'capture_calls'):
        for index, call in enumerate(data.get(key, [])):
            check(call['manifest'], f'{key}[{index}].manifest')
    for key in INPUT_FILES:
        check(data['inputs'][key], f'inputs.{key}')
    for index, run in enumerate(data.get('runs', [])):
        inputs = run['inputs']
        for key in PATH_KEYS:
            if key in inputs:
                check(inputs[key], f'runs[{index}].inputs.{key}')
        for name, spec in _dump_specs(inputs):
            check(spec.get('path') if isinstance(spec, dict) else spec, f'runs[{index}].inputs.{name}')
    acceptance = data['acceptance']
    for key in ('checks', 'dump', 'vars'):
        if key in acceptance:
            check(acceptance[key], f'acceptance.{key}')
    if problems:
        raise cli.InputError(f'{package.root / PACKAGE_FILE}:\n' + '\n'.join(problems))


# ── Step 1 and 2: the manifests and the toolset commit ───────────────


def verify_manifests(package: Package):
    """Checks each file of each manifest against its SHA-256. Returns `(label, path)` of each manifest."""
    verified = []
    for key, tool in (('dump_calls', 'dump_nodes'), ('capture_calls', 'save_screenshots')):
        for index, call in enumerate(package.data.get(key, [])):
            relative = call['manifest']
            path = package.path(relative, f'{key}[{index}].manifest')
            manifest = load_manifest(path)
            if manifest.tool != tool:
                raise cli.InputError(f'{key}[{index}]: {relative} is a manifest of {manifest.tool}, but {key} lists {tool} calls.')
            manifest.verify_all()
            verified.append((relative, path))
    return verified


def check_toolset_commit(package: Package, allow_other: bool, toolset_dir):
    """The current commit; raises when it differs from the recorded one and `allow_other` is off."""
    recorded = package.data['toolset_commit']
    current = toolset_commit(toolset_dir)
    if current != recorded and not allow_other:
        raise cli.InputError(
            f'the toolset is at {current}, but the package recorded {recorded}. Check out the recorded commit '
            'of the toolset, or give --allow-other-commit to run with this one.'
        )
    return {'recorded': recorded, 'current': current, 'same': current == recorded}


# ── Step 3: the scripts ──────────────────────────────────────────────


def run_script_cli(script, argv, where):
    """Runs a script of this toolset in a new process. Exit codes 0 and 1 mean it ran."""
    done = subprocess.run(
        [sys.executable, '-I', '-X', 'utf8', str(TOOLSET_DIR / f'{script}.py'), *argv],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        stdin=subprocess.DEVNULL,
    )
    if done.returncode not in (0, 1):
        detail = (done.stderr.strip() or done.stdout.strip() or f'exit code {done.returncode}').splitlines()
        raise cli.InputError(f'{where}: {script}.py stopped with exit code {done.returncode}: {detail[-1] if detail else ""}')
    return done


def _dump_args(package, spec, inputs, where):
    """`(path, root, format)` of a dump spec, as the self-check reads it."""
    if isinstance(spec, dict):
        path, root, form = spec.get('path'), spec.get('root'), spec.get('format')
    else:
        path, root, form = spec, inputs.get('root'), inputs.get('format')
    return str(package.path(path, where)), root, form


def _dump_options(root, form):
    return (['--root', str(root)] if root else []) + (['--format', form] if form else [])


def _config_args(package):
    return ['--config', str(package.path(package.data['config'], 'config'))]


def script_commands(package, run, out_dir):
    """The command lines of one run: `[(label, argv)]`."""
    script, inputs, run_id = run['script'], run['inputs'], run['id']
    where = f'runs[{run_id}]'
    shared = ['--outputs', str(out_dir), '--fixtures', str(package.root)]

    def file_of(key):
        return str(package.path(inputs[key], f'{where}.inputs.{key}'))

    if script == 'census':
        path, root, form = _dump_args(package, inputs['dump'], inputs, f'{where}.inputs.dump')
        argv = ['audit', path, *_dump_options(root, form), '--label', run_id, '--vars', file_of('variables')]
        argv += ['--exemptions', file_of('exemptions'), *_config_args(package), *shared]
        return [(run_id, argv)]
    if script == 'contrast':
        specs = inputs['dumps'] if 'dumps' in inputs else [inputs['dump']]
        commands = []
        for n, spec in enumerate(specs):
            path, root, form = _dump_args(package, spec, inputs if 'dumps' not in inputs else {}, f'{where}.inputs.dumps[{n}]')
            label = run_id if len(specs) == 1 else f'{run_id}.{n}'
            argv = ['audit', path, *_dump_options(root, form), '--vars', file_of('variables'), *_config_args(package)]
            if inputs.get('context_base'):
                argv += ['--context-base', str(inputs['context_base'])]
            commands.append((label, [*argv, '--label', label, *shared]))
        return commands
    if script == 'sr_precheck':
        path, root, form = _dump_args(package, inputs['dump'], inputs, f'{where}.inputs.dump')
        argv = [path, *_dump_options(root, form), '--mode', inputs.get('mode', 'default'), '--label', run_id, *shared]
        return [(run_id, argv)]
    if script == 'completeness':
        path, _root, form = _dump_args(package, inputs['dump'], inputs, f'{where}.inputs.dump')
        argv = [path, *(['--format', form] if form else [])]
        for key, option in (('components', '--components'), ('page_child_counts', '--page-child-counts')):
            if key in inputs:
                argv += [option, file_of(key)]
        return [(run_id, [*argv, '--label', run_id, *shared])]
    argv = [file_of('capture')]
    if 'manifest' in inputs:
        argv += ['--manifest', file_of('manifest')]
    for key, option in (('tile_size', '--tile-size'), ('overlap', '--overlap')):
        if key in inputs:
            argv += [option, str(inputs[key])]
    return [(run_id, [*argv, '--label', run_id, *shared])]


def read_config(package) -> AuditConfig:
    if 'config' not in package.data:
        return AuditConfig()
    path = package.path(package.data['config'], 'config')
    return parse_config(load_json(path), str(path))


def figures_of(package, run, config, out_dir):
    """The figures of one run, worked out in this process (`tile`: read from its own output)."""
    if run['script'] == 'tile':
        report = load_json(out_dir / f'{run["id"]}.tiles.json')
        return {**report, 'tile_count': len(report['tiles'])}
    return selfcheck.run_script(package.root, run['script'], run['inputs'], config)


def run_scripts(package, outputs):
    """Runs each script of the package; returns `[(run, figures, tile manifest path or None)]`."""
    config = read_config(package)
    results = []
    for run in package.data.get('runs', []):
        out_dir = outputs.path(f'scripts/{run["id"]}/.keep').parent
        out_dir.joinpath('.keep').unlink(missing_ok=True)
        for _label, argv in script_commands(package, run, out_dir):
            run_script_cli(run['script'], argv, f'runs[{run["id"]}]')
        figures = figures_of(package, run, config, out_dir)
        tiles = out_dir / f'{run["id"]}.tiles.json' if run['script'] == 'tile' else None
        results.append((run, figures, tiles))
    return results


def run_acceptance(package, outputs):
    """Runs assert.py on the checks file; returns the path of its output."""
    acceptance = package.data['acceptance']
    label = acceptance.get('label', 'acceptance')
    out_dir = outputs.path(f'scripts/{label}/.keep').parent
    out_dir.joinpath('.keep').unlink(missing_ok=True)
    argv = [
        str(package.path(acceptance['checks'], 'acceptance.checks')),
        str(package.path(acceptance['dump'], 'acceptance.dump')),
    ]
    if acceptance.get('root'):
        argv += ['--root', str(acceptance['root'])]
    if acceptance.get('format'):
        argv += ['--format', acceptance['format']]
    if 'vars' in acceptance:
        argv += ['--vars', str(package.path(acceptance['vars'], 'acceptance.vars'))]
    if 'config' in package.data:
        argv += _config_args(package)
    argv += ['--label', label, '--outputs', str(out_dir), '--fixtures', str(package.root)]
    run_script_cli('assert', argv, 'acceptance')
    return out_dir / f'{label}.assert.json'


# ── Step 5: the comparison ───────────────────────────────────────────


def acceptance_figures(assert_path):
    """The figures of the assert output that a package can record: the totals and each check by ID."""
    data = load_json(assert_path)
    return {
        'summary': data['summary'],
        'checks': {row['id']: {'result': row['result'], 'observed': row['observed']} for row in data['results']},
    }


def compare(name, figures, wanted, match):
    """One line for each recorded figure: `{name, figure, status, observed, expected}`."""
    lines = []
    for figure, expected in wanted.items():
        try:
            observed = selfcheck.figure_at(figures, figure)
            ok = selfcheck.matches(observed, expected, match)
        except KeyError:
            observed, ok = '(no such figure)', False
        lines.append(
            {'run': name, 'figure': figure, 'status': 'MATCH' if ok else 'MISMATCH', 'observed': observed, 'expected': expected}
        )
    return lines


def main():
    parser = argparse.ArgumentParser(description='Reproduce each figure of an audit from the dumps of a package')
    parser.add_argument('package', help='The package folder with audit-package.json')
    parser.add_argument('--outputs', required=True, help='The outputs folder, outside the package')
    parser.add_argument('--allow-other-commit', action='store_true', help='Run with a toolset commit other than the recorded one')
    parser.add_argument('--toolset-dir', default=None, help='The checkout of the toolset (default: this folder)')
    args = parser.parse_args()

    package = read_package(args.package)
    verified = verify_manifests(package)
    commit = check_toolset_commit(package, args.allow_other_commit, args.toolset_dir)
    outputs = OutputDir(args.outputs, package.root)

    lines = []
    if not commit['same']:
        lines.append(f'WARNING the toolset is at {commit["current"]}, not at the recorded {commit["recorded"]} (--allow-other-commit)')
    results = run_scripts(package, outputs)
    assert_path = run_acceptance(package, outputs)

    inputs = package.data['inputs']
    paths = {key: package.path(inputs[key], f'inputs.{key}') for key in INPUT_FILES}
    seeds = render_report.check_seeds(package.data.get('seeds', {}), PACKAGE_FILE)
    model = render_report.build_report(
        [assert_path],
        paths['surfaces'],
        paths['prescription_errors'],
        paths['defects'],
        verified,
        [tiles for _run, _figures, tiles in results if tiles is not None],
        seeds,
        args.toolset_dir,
    )
    outputs.write_text('report.md', render_report.render_markdown(model))

    compared = []
    for run, figures, _tiles in results:
        if 'figures' in run:
            compared += compare(run['id'], figures, run['figures'], run.get('match', 'exact'))
    acceptance = package.data['acceptance']
    if 'figures' in acceptance:
        compared += compare(
            acceptance.get('label', 'acceptance'),
            acceptance_figures(assert_path),
            acceptance['figures'],
            acceptance.get('match', 'exact'),
        )
    recorded_verdict = package.data.get('recorded', {}).get('verdict')
    if recorded_verdict is not None:
        compared.append(
            {
                'run': 'report',
                'figure': 'verdict',
                'status': 'MATCH' if recorded_verdict == model['verdict'] else 'MISMATCH',
                'observed': model['verdict'],
                'expected': recorded_verdict,
            }
        )

    mismatched = sum(1 for line in compared if line['status'] == 'MISMATCH')
    for line in compared:
        lines.append(
            f'{line["status"]} {line["run"]} {line["figure"]} '
            f'observed={json.dumps(line["observed"], ensure_ascii=False, sort_keys=True)} '
            f'expected={json.dumps(line["expected"], ensure_ascii=False, sort_keys=True)}'
        )
    summary = f'RERUN {"MISMATCH" if mismatched else "MATCH"} figures={len(compared)} mismatched={mismatched} verdict={model["verdict"]}'
    if not compared:
        lines.append('NOTE the package recorded no figure, so nothing was compared')
    for line in [*lines, summary]:
        print(line)
    outputs.write_text('run_audit.txt', '\n'.join([*lines, summary]) + '\n')
    outputs.write_json(
        'run_audit.json',
        {'toolset': commit, 'verdict': model['verdict'], 'figures': compared, 'mismatched': mismatched},
    )
    return cli.EXIT_FAILED if mismatched else cli.EXIT_OK


if __name__ == '__main__':
    cli.run(main)
