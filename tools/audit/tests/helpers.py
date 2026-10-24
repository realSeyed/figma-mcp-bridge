"""Test helpers: the paths, the synthetic data, and a writer of `dump_nodes` folders.

Each piece of test data is synthetic: the hand-written files of `data/` and
the golden dump of the conformance fixture (`server/scripts/golden/`). A dump
folder is written at run time, as `dump_nodes` writes it: one canonical JSON
file for each root and `manifest.json` with the SHA-256 of each file. The
repository keeps the readable source, which Prettier may format freely.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AUDIT = Path(__file__).resolve().parents[1]
REPO = AUDIT.parents[1]
DATA = AUDIT / 'tests' / 'data'
GOLDEN = REPO / 'server' / 'scripts' / 'golden' / 'dump-conformance.json'

if str(AUDIT) not in sys.path:
    sys.path.insert(0, str(AUDIT))

from auditlib.manifest import canonical_json, sha256_bytes  # noqa: E402

OUTPUT_PATH = 'dumps/20260101T000000Z'


def data(name):
    """A parsed file of `data/`."""
    return json.loads((DATA / name).read_text(encoding='utf-8'))


def golden(root):
    """One root of the golden dump: `button-set`, `screen`, or `target`."""
    return json.loads(GOLDEN.read_text(encoding='utf-8'))[root]


def _counts(root):
    nodes = hidden = variants = 0
    stack = [(root, None)]
    while stack:
        node, parent = stack.pop()
        nodes += 1
        if node.get('styles', {}).get('visible') is False:
            hidden += 1
        if parent is not None and parent.get('type') == 'COMPONENT_SET' and node.get('type') == 'COMPONENT':
            variants += 1
        stack.extend((child, node) for child in node.get('children', []))
    return nodes, hidden, variants


def write_dump_folder(folder, roots, include_hidden=True, variables=None):
    """Writes a `dump_nodes` folder: canonical files and `manifest.json`."""
    folder = Path(folder)
    folder.mkdir(parents=True)
    files = []
    for root in roots:
        name = root['id'].replace(':', '_') + '.json'
        raw = canonical_json(root).encode('utf-8')
        (folder / name).write_bytes(raw)
        nodes, hidden, variants = _counts(root)
        files.append(
            {
                'kind': 'nodes',
                'nodeId': root['id'],
                'path': f'{OUTPUT_PATH}/{name}',
                'sha256': sha256_bytes(raw),
                'bytes': len(raw),
                'nodeCount': nodes,
                'hiddenCount': hidden,
                'variantCount': variants,
            }
        )
    if variables is not None:
        raw = canonical_json(variables).encode('utf-8')
        (folder / 'variables.json').write_bytes(raw)
        files.append(
            {
                'kind': 'variables',
                'nodeId': None,
                'path': f'{OUTPUT_PATH}/variables.json',
                'sha256': sha256_bytes(raw),
                'bytes': len(raw),
                'nodeCount': None,
                'hiddenCount': None,
                'variantCount': None,
            }
        )
    manifest = {
        'tool': 'dump_nodes',
        'fileKey': 'synthetic-file',
        'bridgeCommit': '0' * 40,
        'leaderCommit': '0' * 40,
        'pluginBuild': '0' * 40 + '+' + '0' * 16,
        'epoch': 1,
        'leaderStartedAt': '2026-01-01T00:00:00.000Z',
        'outputRoot': '/synthetic/output-root',
        'startedAt': '2026-01-01T00:00:00.000Z',
        'finishedAt': '2026-01-01T00:00:01.000Z',
        'files': files,
        'outputPath': OUTPUT_PATH,
        'includeHidden': include_hidden,
        'includeVariables': variables is not None,
        'includeStyles': False,
    }
    (folder / 'manifest.json').write_bytes(canonical_json(manifest).encode('utf-8'))
    return folder


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    return path


def run_script(script, *args):
    """Runs a script of the toolset in a new process; returns the completed process."""
    return subprocess.run(
        [sys.executable, str(AUDIT / script), *[str(a) for a in args]],
        capture_output=True,
        text=True,
        encoding='utf-8',
    )


class TempDirTestCase(unittest.TestCase):
    """A test case with a fresh temporary folder in `self.tmp`."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='audit-test-')).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
