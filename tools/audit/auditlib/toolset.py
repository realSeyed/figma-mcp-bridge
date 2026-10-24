"""The commit of the toolset checkout, for the anchors of a report and the re-run of a package.

The commit is the full hash of 40 characters (`git rev-parse HEAD` in the
checkout), plus `-dirty` when `git status --porcelain` prints a line, as the
bridge writes its own `bridgeCommit`. A checkout with changes is thus never
taken for the tagged commit that an audit pins.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

COMMIT = re.compile(r'[0-9a-f]{40}(-dirty)?')

TOOLSET_DIR = Path(__file__).resolve().parents[1]
"""The folder of the toolset (`tools/audit`); git finds the checkout from there."""


class ToolsetError(Exception):
    """The commit of the toolset checkout cannot be read."""


def _git(folder: Path, *args: str) -> str:
    try:
        done = subprocess.run(
            ['git', '-C', str(folder), *args],
            capture_output=True,
            text=True,
            encoding='utf-8',
            stdin=subprocess.DEVNULL,
        )
    except OSError as err:
        raise ToolsetError(f'git cannot run: {err}. The toolset commit cannot be read without git.') from None
    if done.returncode != 0:
        detail = done.stderr.strip().splitlines()[-1] if done.stderr.strip() else f'exit code {done.returncode}'
        raise ToolsetError(
            f'{folder}: git {" ".join(args)} failed ({detail}). Run the toolset from a git checkout '
            'of a tagged commit of this repository.'
        )
    return done.stdout


def toolset_commit(folder=None) -> str:
    """The commit of the checkout that holds `folder`, with `-dirty` for an unclean tree.

    Raises `ToolsetError` when `folder` is not in a git checkout or git fails.
    """
    folder = Path(folder) if folder is not None else TOOLSET_DIR
    commit = _git(folder, 'rev-parse', 'HEAD').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ToolsetError(f'{folder}: git rev-parse HEAD printed {commit!r}, not a commit hash.')
    dirty = _git(folder, 'status', '--porcelain').strip() != ''
    return f'{commit}-dirty' if dirty else commit
