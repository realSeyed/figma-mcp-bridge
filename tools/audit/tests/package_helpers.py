"""A synthetic audit package, written at run time from the golden dump of the conformance fixture.

The package follows the layout of `tools/audit/README.md`: one `dump_nodes` call
(the roots `button-set` and `screen`), one capture call with a PNG that the test
writes, the inputs of the report, a checks file, and the runs with their
recorded figures. The recorded figures are worked out by hand from the golden
dump; see the comments.
"""

import json
import subprocess
from pathlib import Path

from . import helpers
from .test_tile import make_png

from auditlib.manifest import canonical_json, sha256_bytes
from auditlib.toolset import toolset_commit

CAPTURE_NAME = 'save_screenshots-20260101T000000Z.manifest.json'
IDENTITY = {
    'bridgeCommit': 'b' * 40,
    'leaderCommit': 'b' * 40,
    'pluginBuild': 'c' * 40 + '+' + 'd' * 16,
    'epoch': 3,
    'leaderStartedAt': '2026-01-01T00:00:00.000Z',
}

CHECKS = [
    # The set has two variants: N2 and N6.
    {'id': 'C-1', 'node': 'N1', 'measure': 'variantCount', 'op': 'eq', 'expected': 2},
    # The screen has five children: N10, N11, N14, N15, N16.
    {'id': 'C-2', 'node': 'N9', 'measure': 'childCount', 'op': 'eq', 'expected': 5},
    {'id': 'C-3', 'node': 'N9', 'field': 'type', 'op': 'eq', 'expected': 'FRAME'},
]

SURFACES = [
    {
        'frame': 'synthetic screen',
        'surface': 'default',
        'read': ['dump run1, root N9', 'census run', 'capture frame.png'],
        'captures': ['captures/frame.png'],
        'tiles': ['tiles.r00c00.png', 'tiles.r00c01.png'],
    }
]
ERRORS = [{'id': 'PE-1', 'text': 'A synthetic prescription error.', 'status': 'closed'}]
DEFECTS = [{'id': 'D-1', 'text': 'A synthetic carried defect.', 'since': 'audit 0'}]


def write_json_file(path, value):
    return helpers.write_json(path, value)


def build_package(tmp, **changes):
    """Writes a package under `tmp / 'package'` and returns its folder.

    `changes` is a dict of top-level keys to replace in `audit-package.json`.
    """
    root = Path(tmp) / 'package'
    helpers.write_dump_folder(
        root / 'dumps' / 'run1',
        [helpers.golden('button-set'), helpers.golden('screen')],
        variables=helpers.data('variables.json'),
    )
    # The manifest helper writes the dump manifest identity; give it the identity of this package.
    manifest_path = root / 'dumps' / 'run1' / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['outputPath'] = 'dumps/run1'
    for entry in manifest['files']:
        entry['path'] = 'dumps/run1/' + entry['path'].rsplit('/', 1)[1]
    manifest.update(IDENTITY)
    manifest_path.write_bytes(canonical_json(manifest).encode('utf-8'))

    png = make_png(250, 120)
    (root / 'captures').mkdir()
    (root / 'captures' / 'frame.png').write_bytes(png)
    capture_manifest = {
        'tool': 'save_screenshots',
        **IDENTITY,
        'files': [
            {
                'kind': 'capture',
                'index': 0,
                'path': 'captures/frame.png',
                'sha256': sha256_bytes(png),
                'bytes': len(png),
                'format': 'PNG',
                'scale': 1,
                'pixelWidth': 250,
                'pixelHeight': 120,
                'ok': True,
            }
        ],
        'manifestPath': f'captures/{CAPTURE_NAME}',
        'total': 1,
        'succeeded': 1,
        'failed': 0,
        'hasErrors': False,
    }
    write_json_file(root / 'captures' / CAPTURE_NAME, capture_manifest)

    inputs = root / 'inputs'
    for name in ('config.json', 'exemptions.json', 'components.json'):
        write_json_file(inputs / name, helpers.data(name))
    write_json_file(inputs / 'surfaces.json', SURFACES)
    write_json_file(inputs / 'prescription-errors.json', ERRORS)
    write_json_file(inputs / 'defects.json', DEFECTS)
    write_json_file(root / 'checks.json', CHECKS)

    package = {
        'schema': 1,
        'toolset_commit': toolset_commit(),
        'seeds': {},
        'config': 'inputs/config.json',
        'dump_calls': [{'name': 'run1', 'manifest': 'dumps/run1/manifest.json'}],
        'capture_calls': [{'name': 'shots', 'manifest': f'captures/{CAPTURE_NAME}'}],
        'inputs': {
            'surfaces': 'inputs/surfaces.json',
            'prescription_errors': 'inputs/prescription-errors.json',
            'defects': 'inputs/defects.json',
        },
        'runs': [
            {
                'id': 'completeness-set',
                'script': 'completeness',
                'inputs': {
                    'dump': 'dumps/run1',
                    'root': 'N1',
                    'components': 'inputs/components.json',
                },
                # components.json lists N1 with 2 variants; the set carries N2 and N6.
                'figures': {
                    'set_completeness.result': 'PASS',
                    'set_completeness.carried': 2,
                    'set_completeness.expected': 2,
                },
            },
            {
                'id': 'census-screen',
                'script': 'census',
                'inputs': {
                    'dump': 'dumps/run1',
                    'root': 'N9',
                    'variables': 'dumps/run1/variables.json',
                    'exemptions': 'inputs/exemptions.json',
                },
                # Nine visible SOLID fills of the screen carry no binding (counted by hand in the test),
                # and the screen has no radius and no spacing.
                'figures': {'unbound_paints.count': 9, 'radius.bearing': 0, 'spacing.raw_nonzero': 0},
            },
            {
                'id': 'tiles',
                'script': 'tile',
                'inputs': {
                    'capture': 'captures/frame.png',
                    'manifest': f'captures/{CAPTURE_NAME}',
                    'tile_size': 100,
                    'overlap': 20,
                },
                # 250 x 120 in tiles of 100 with an overlap of 20: three columns, two rows.
                'figures': {'tile_count': 6, 'source.pixelWidth': 250, 'source.pixelHeight': 120},
            },
        ],
        'acceptance': {
            'checks': 'checks.json',
            'dump': 'dumps/run1',
            'figures': {'summary.checks': 3, 'summary.failed': 0, 'checks.C-1.observed': 2},
        },
        'recorded': {'verdict': 'PASS'},
    }
    package.update(changes)
    write_json_file(root / 'audit-package.json', package)
    return root


def rewrite_package(root, **changes):
    path = Path(root) / 'audit-package.json'
    package = json.loads(path.read_text(encoding='utf-8'))
    package.update(changes)
    write_json_file(path, package)


def make_git_repo(folder):
    """A clean git repository with one commit; returns its commit hash."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)

    def git(*args):
        return subprocess.run(
            ['git', '-C', str(folder), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', *args],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    git('init', '-q')
    (folder / 'file.txt').write_text('one\n', encoding='utf-8')
    git('add', 'file.txt')
    git('commit', '-q', '-m', 'one')
    return git('rev-parse', 'HEAD')
