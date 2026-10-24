#!/usr/bin/env python3
"""render_report.py — render the audit report from script outputs only.

    python tools/audit/render_report.py --assert <label.assert.json> [...] \\
        --surfaces <surfaces.json> --prescription-errors <errors.json> --defects <defects.json> \\
        --manifest [LABEL=]<manifest> [...] [--tiles <label.tiles.json> ...] [--seeds <seeds.json>] \\
        [--toolset-dir <folder>] [--name report.md] --outputs <folder>

The report holds no figure that a person typed. Each figure comes from an
output file of a script (the acceptance table from `assert.py`, the tiles from
`tile.py`), from a manifest of the bridge (the anchors), or from `git` (the
toolset commit). The auditor writes three small input files: the surface
declaration of each frame, the prescription errors, and the carried defects.
Their format is in `tools/audit/README.md`.

The verdict has a written rule: PASS when at least one acceptance check ran,
each acceptance check passed, and no prescription error is open; otherwise
FAIL. A missing or unusable file stops the run and writes no report: the
renderer does not invent a figure.

Exit codes: 0 when the verdict is PASS, 1 when it is FAIL, 2 when an input is
missing, wrong, or does not match its manifest.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.dumps import load_json  # noqa: E402
from auditlib.manifest import load_manifest, sha256_file  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402
from auditlib.toolset import toolset_commit  # noqa: E402

VERDICT_RULE = (
    'PASS when at least one acceptance check ran, each acceptance check passed, '
    'and no prescription error is open; otherwise FAIL.'
)
SCRIPTS = ('census', 'contrast', 'sr_precheck', 'completeness', 'assert', 'diff_dumps', 'tile', 'selfcheck')
SURFACE_KEYS = ('frame', 'surface', 'read', 'captures', 'tiles')
ERROR_KEYS = ('id', 'text', 'status', 'frame')
DEFECT_KEYS = ('id', 'text', 'frame', 'since')
STATUSES = ('open', 'closed')
IDENTITY_KEYS = ('bridgeCommit', 'leaderCommit', 'pluginBuild', 'epoch', 'leaderStartedAt')
SHOWN_WIDTH = 48


# ── Reading the inputs ───────────────────────────────────────────────


def _is_text(value):
    return isinstance(value, str) and value.strip() != ''


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _list_input(path, what):
    data = load_json(path)
    if not isinstance(data, list):
        raise cli.InputError(f'{path}: {what} must be a JSON array.')
    return data


def _check_rows(path, rows, name, keys, required, text_keys, enums=None):
    """Checks a list of objects against its keys; returns the rows or raises with every bad row listed."""
    problems = []
    seen = {}
    for index, row in enumerate(rows):
        at = f'{name}[{index}]'
        if not isinstance(row, dict):
            problems.append(f'{at}: must be an object.')
            continue
        unknown = sorted(set(row) - set(keys))
        if unknown:
            problems.append(f'{at}: unknown keys {", ".join(unknown)}. The keys are: {", ".join(keys)}.')
        for key in required:
            if key not in row:
                problems.append(f'{at}.{key}: is required.')
        for key in text_keys:
            if key in row and not _is_text(row[key]):
                problems.append(f'{at}.{key}: must be a text that is not empty.')
        for key, allowed in (enums or {}).items():
            if _is_text(row.get(key)) and row[key] not in allowed:
                problems.append(f'{at}.{key}: "{row[key]}" is not known; use {" or ".join(allowed)}.')
        if _is_text(row.get('id')):
            if row['id'] in seen:
                problems.append(f'{at}.id: "{row["id"]}" repeats {name}[{seen[row["id"]]}].')
            seen[row['id']] = index
    if problems:
        raise cli.InputError(f'{path}: ' + '\n'.join(problems))
    return rows


def read_prescription_errors(path):
    return _check_rows(
        path,
        _list_input(path, 'the prescription errors'),
        'errors',
        ERROR_KEYS,
        ('id', 'text', 'status'),
        ('id', 'text', 'status', 'frame'),
        enums={'status': STATUSES},
    )


def read_defects(path):
    return _check_rows(
        path, _list_input(path, 'the carried defects'), 'defects', DEFECT_KEYS, ('id', 'text'), ('id', 'text', 'frame', 'since')
    )


def read_surfaces(path):
    rows = _list_input(path, 'the surface declaration')
    problems = []
    for index, row in enumerate(rows):
        at = f'surfaces[{index}]'
        if not isinstance(row, dict):
            problems.append(f'{at}: must be an object.')
            continue
        unknown = sorted(set(row) - set(SURFACE_KEYS))
        if unknown:
            problems.append(f'{at}: unknown keys {", ".join(unknown)}. The keys are: {", ".join(SURFACE_KEYS)}.')
        for key in ('frame', 'surface'):
            if not _is_text(row.get(key)):
                problems.append(f'{at}.{key}: must be a text that is not empty.')
        for key in SURFACE_KEYS[2:]:
            value = row.get(key)
            if not isinstance(value, list) or not all(_is_text(item) for item in value):
                problems.append(f'{at}.{key}: must be a list of texts (it may be empty).')
        if isinstance(row.get('read'), list) and not row['read']:
            problems.append(f'{at}.read: must name what was read; a surface that read nothing is not declared.')
    if problems:
        raise cli.InputError(f'{path}: ' + '\n'.join(problems))
    return rows


def check_seeds(data, path):
    """Checks a parsed seeds object; returns it sorted by script name."""
    if not isinstance(data, dict):
        raise cli.InputError(f'{path}: the seeds must be a JSON object of script name to seed.')
    problems = []
    for name, seed in data.items():
        if name not in SCRIPTS:
            problems.append(f'seeds["{name}"]: is not a script of the toolset; use one of {", ".join(SCRIPTS)}.')
        elif not _is_int(seed) or seed < 0:
            problems.append(f'seeds["{name}"]: must be an integer of 0 or more.')
    if problems:
        raise cli.InputError(f'{path}: ' + '\n'.join(problems))
    return dict(sorted(data.items()))


def read_seeds(path):
    return {} if path is None else check_seeds(load_json(path), path)


def read_assertion(path):
    """An `assert.py` output, with the totals worked out again from its rows."""
    path = Path(path)
    data = load_json(path)
    if not isinstance(data, dict) or not isinstance(data.get('results'), list) or not isinstance(data.get('summary'), dict):
        raise cli.InputError(f'{path}: this is not an output of assert.py: it has no results and no summary.')
    checks_file = data.get('checksFile')
    if not isinstance(checks_file, dict) or not _is_text(checks_file.get('sha256')):
        raise cli.InputError(f'{path}: the output does not record the SHA-256 of its checks file.')
    rows = []
    for index, result in enumerate(data['results']):
        at = f'{path}: results[{index}]'
        if not isinstance(result, dict) or not _is_text(result.get('id')) or result.get('result') not in ('PASS', 'FAIL'):
            raise cli.InputError(f'{at} is not a result of assert.py.')
        subject = result.get('field', result.get('measure'))
        if not _is_text(result.get('node')) or not _is_text(subject) or not _is_text(result.get('op')):
            raise cli.InputError(f'{at} has no node, field or measure, or operator.')
        rows.append(result)
    failed = sum(1 for row in rows if row['result'] == 'FAIL')
    observed = {'checks': len(rows), 'passed': len(rows) - failed, 'failed': failed}
    recorded = {key: data['summary'].get(key) for key in observed}
    if recorded != observed:
        raise cli.InputError(
            f'{path}: its summary {json.dumps(recorded)} does not match its rows {json.dumps(observed)}. '
            'The output changed after assert.py wrote it; run assert.py again.'
        )
    name = path.name[: -len('.assert.json')] if path.name.endswith('.assert.json') else path.stem
    return {'label': name, 'checksSha256': checks_file['sha256'], 'summary': observed, 'results': rows}


def split_label(spec):
    """`LABEL=path`, or a bare path that is labelled by its folder and file name."""
    label, sep, rest = spec.partition('=')
    if sep and label and '/' not in label and '\\' not in label and ':' not in label:
        return label, Path(rest)
    path = Path(spec)
    return f'{path.resolve().parent.name}/{path.name}', path


def read_manifest(spec):
    """A manifest of the bridge, with every listed file checked, as the anchors need it."""
    label, path = spec if isinstance(spec, tuple) else split_label(spec)
    manifest = load_manifest(path)
    manifest.verify_all()
    missing = [key for key in IDENTITY_KEYS if manifest.data.get(key) in (None, '')]
    if missing:
        raise cli.InputError(
            f'{path}: the manifest has no {", ".join(missing)}, so the anchors cannot be written. '
            'Use a manifest as the bridge wrote it.'
        )
    data = manifest.data
    failed = data.get('failed')
    return {
        'label': label,
        'tool': manifest.tool or 'unknown',
        'sha256': sha256_file(path),
        'bridgeCommit': data['bridgeCommit'],
        'leaderCommit': data['leaderCommit'],
        'pluginBuild': data['pluginBuild'],
        'epoch': data['epoch'],
        'leaderStartedAt': data['leaderStartedAt'],
        'failedItems': failed if _is_int(failed) else 0,
        'files': [
            {'path': entry.listed_path, 'bytes': entry.size, 'sha256': entry.sha256}
            for entry in manifest.entries
        ],
    }


def read_tiles(path):
    data = load_json(path)
    if not isinstance(data, dict) or not isinstance(data.get('tiles'), list):
        raise cli.InputError(f'{path}: this is not an output of tile.py: it has no tiles list.')
    return {tile['file'] for tile in data['tiles'] if isinstance(tile, dict) and isinstance(tile.get('file'), str)}


# ── The report ───────────────────────────────────────────────────────


def check_declarations(surfaces, surfaces_path, manifests, tile_names):
    """Each declared capture is listed by a capture manifest, and each declared tile by a tile manifest."""
    captured = {
        file['path']
        for manifest in manifests
        if manifest['tool'] == 'save_screenshots'
        for file in manifest['files']
    }
    problems = []
    for index, row in enumerate(surfaces):
        for key, known, source in (
            ('captures', captured, 'capture manifest (--manifest)'),
            ('tiles', tile_names, 'tile manifest (--tiles)'),
        ):
            for item in row[key]:
                if item not in known:
                    problems.append(f'surfaces[{index}].{key}: "{item}" is not listed by any {source} that was given.')
    if problems:
        raise cli.InputError(f'{surfaces_path}: ' + '\n'.join(problems))


def decide(assertions, errors):
    """The verdict and the reasons for it, by the written rule."""
    total = sum(a['summary']['checks'] for a in assertions)
    failed = sum(a['summary']['failed'] for a in assertions)
    open_errors = [e['id'] for e in errors if e['status'] == 'open']
    reasons = []
    if total == 0:
        reasons.append('no acceptance check ran')
    if failed:
        reasons.append(f'{failed} of {total} acceptance checks failed')
    if open_errors:
        reasons.append(f'{len(open_errors)} prescription errors are open: {", ".join(open_errors)}')
    return ('FAIL' if reasons else 'PASS'), reasons


def build_report(assert_paths, surfaces_path, errors_path, defects_path, manifest_specs, tile_paths, seeds, toolset_dir=None):
    """Reads each input and returns the model of the report. Raises on the first unusable input.

    `manifest_specs` are `[LABEL=]path` texts, or `(label, path)` tuples. `seeds` is a checked object.
    """
    if not assert_paths:
        raise cli.InputError('no assert.py output was given; the acceptance table needs at least one (--assert).')
    if not manifest_specs:
        raise cli.InputError('no manifest was given; the anchors need at least one (--manifest).')
    assertions = [read_assertion(path) for path in assert_paths]
    labels = [a['label'] for a in assertions]
    repeated = sorted({label for label in labels if labels.count(label) > 1})
    if repeated:
        raise cli.InputError(f'two assert.py outputs have the label {", ".join(repeated)}; give each a different --label.')
    surfaces = read_surfaces(surfaces_path)
    errors = read_prescription_errors(errors_path)
    defects = read_defects(defects_path)
    manifests = [read_manifest(spec) for spec in manifest_specs]
    tile_names = set()
    for path in tile_paths:
        tile_names |= read_tiles(path)
    check_declarations(surfaces, surfaces_path, manifests, tile_names)
    commit = toolset_commit(toolset_dir)
    verdict, reasons = decide(assertions, errors)
    return {
        'assertions': assertions,
        'surfaces': surfaces,
        'prescriptionErrors': errors,
        'defects': defects,
        'anchors': {'toolsetCommit': commit, 'manifests': manifests, 'seeds': seeds},
        'verdict': verdict,
        'reasons': reasons,
    }


# ── Markdown ─────────────────────────────────────────────────────────


def _cell(value):
    return str(value).replace('\\', '\\\\').replace('|', '\\|').replace('\r', ' ').replace('\n', ' ')


def _shown(value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return text if len(text) <= SHOWN_WIDTH else text[: SHOWN_WIDTH - 1] + '…'


def _table(header, rows):
    lines = ['| ' + ' | '.join(header) + ' |', '| ' + ' | '.join('---' for _ in header) + ' |']
    lines += ['| ' + ' | '.join(_cell(cell) for cell in row) + ' |' for row in rows]
    return lines


def _code(value):
    return f'`{value}`'


def render_markdown(model):
    """The report as Markdown. It holds no time and no path, so the same inputs give the same text."""
    out = ['# Audit report', '', f'Verdict: **{model["verdict"]}**', '']

    out += ['## Acceptance', '']
    for assertion in model['assertions']:
        summary = assertion['summary']
        out += [f'### {assertion["label"]}', '']
        rows = []
        for r in assertion['results']:
            subject = r.get('field', r.get('measure'))
            expected = '-' if r['op'] in ('exists', 'absent') else _shown(r.get('expected'))
            observed = _shown(r.get('observed')) if r.get('present') else '(absent)'
            rows.append([r['id'], r['node'], subject, r['op'], expected, observed, r['result']])
        out += _table(['ID', 'Node', 'Field / measure', 'Op', 'Expected', 'Observed', 'Result'], rows)
        out += [
            '',
            f'{summary["checks"]} checks, {summary["passed"]} passed, {summary["failed"]} failed. '
            f'Checks file SHA-256: {_code(assertion["checksSha256"])}.',
            '',
        ]

    out += ['## Surfaces', '']
    if not model['surfaces']:
        out += ['No surface is declared.', '']
    for surface in model['surfaces']:
        out += [f'### {surface["frame"]} — {surface["surface"]}', '']
        out += ['Read:'] + [f'- {item}' for item in surface['read']]
        for key, title in (('captures', 'Captures'), ('tiles', 'Tiles')):
            items = surface[key]
            out += ['', f'{title}: {len(items)}' + (':' if items else '.')] + [f'- {item}' for item in items]
        out.append('')

    out += ['## Prescription errors', '']
    if model['prescriptionErrors']:
        rows = [[e['id'], e.get('frame', ''), e['status'], e['text']] for e in model['prescriptionErrors']]
        out += _table(['ID', 'Frame', 'Status', 'Text'], rows)
    else:
        out.append('None. The input file lists no prescription error.')
    out.append('')

    out += ['## Carried defects', '']
    if model['defects']:
        rows = [[d['id'], d.get('frame', ''), d.get('since', ''), d['text']] for d in model['defects']]
        out += _table(['ID', 'Frame', 'Since', 'Text'], rows)
    else:
        out.append('None. The input file lists no carried defect.')
    out.append('')

    anchors = model['anchors']
    out += ['## Anchors', '', f'Toolset commit: {_code(anchors["toolsetCommit"])}', '']
    out += _table(
        ['Manifest', 'Tool', 'Manifest SHA-256', 'Bridge commit', 'Leader commit', 'Plugin build', 'Epoch', 'Leader started'],
        [
            [
                m['label'],
                m['tool'],
                m['sha256'],
                m['bridgeCommit'],
                m['leaderCommit'],
                m['pluginBuild'],
                m['epoch'],
                m['leaderStartedAt'],
            ]
            for m in anchors['manifests']
        ],
    )
    out.append('')
    for m in anchors['manifests']:
        out += [f'### Files of {m["label"]}', '']
        if m['failedItems']:
            out += [f'{m["failedItems"]} items failed and have no file.', '']
        out += _table(['File', 'Bytes', 'SHA-256'], [[f['path'], f['bytes'] if f['bytes'] is not None else '', f['sha256']] for f in m['files']])
        out.append('')
    out += ['### Seeds', '']
    if anchors['seeds']:
        out += _table(['Script', 'Seed'], [[name, seed] for name, seed in anchors['seeds'].items()])
    else:
        out.append('None declared. No script of this audit used a seed.')
    out.append('')

    out += ['## Verdict', '', f'**{model["verdict"]}**', '', f'Rule: {VERDICT_RULE}', '']
    if model['reasons']:
        out += ['Reasons:'] + [f'- {reason}' for reason in model['reasons']] + ['']
    return '\n'.join(out)


def main():
    parser = argparse.ArgumentParser(description='Render the audit report from script outputs')
    parser.add_argument('--assert', dest='asserts', nargs='+', required=True, metavar='OUTPUT', help='The <label>.assert.json output of assert.py')
    parser.add_argument('--surfaces', required=True, help='The surface declaration of each frame (a JSON array)')
    parser.add_argument('--prescription-errors', required=True, help='The prescription errors (a JSON array)')
    parser.add_argument('--defects', required=True, help='The carried defects (a JSON array)')
    parser.add_argument('--manifest', dest='manifests', nargs='+', required=True, metavar='[LABEL=]MANIFEST', help='The manifest of each dump_nodes or save_screenshots call')
    parser.add_argument('--tiles', nargs='*', default=[], metavar='OUTPUT', help='The <label>.tiles.json output of tile.py')
    parser.add_argument('--seeds', default=None, help='A JSON object of script name to seed, for each script that uses one')
    parser.add_argument('--toolset-dir', default=None, help='The checkout of the toolset (default: this folder)')
    parser.add_argument('--name', default='report.md', help='The name of the report file (default report.md)')
    cli.add_outputs_option(parser)
    args = parser.parse_args()

    outputs = OutputDir(args.outputs, args.fixtures)
    model = build_report(
        args.asserts,
        args.surfaces,
        args.prescription_errors,
        args.defects,
        args.manifests,
        args.tiles,
        read_seeds(args.seeds),
        args.toolset_dir,
    )
    path = outputs.write_text(args.name, render_markdown(model))
    print(f'render_report: {len(model["assertions"])} assert outputs, {len(model["anchors"]["manifests"])} manifests. Written to {path}')
    print(f'VERDICT {model["verdict"]}' + (f' ({"; ".join(model["reasons"])})' if model['reasons'] else ''))
    return cli.EXIT_OK if model['verdict'] == 'PASS' else cli.EXIT_FAILED


if __name__ == '__main__':
    cli.run(main)
