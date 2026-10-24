"""The guard that keeps each write of a script inside its outputs folder.

A script writes only under the outputs folder that its command line gives.
It never writes into an evidence folder or into the fixtures folder, also not
into a folder below one of them. A folder is protected when it holds:

- `manifest.json` or a `*.manifest.json` file: an evidence folder of
  `dump_nodes` or `save_screenshots`;
- `expected.json`: a fixtures folder of known answers;

or when the command line names it as the fixtures folder. Paths are compared
as real paths, so a symbolic link or a junction does not pass the guard.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from .manifest import CAPTURE_MANIFEST_SUFFIX, DUMP_MANIFEST_NAME

EXPECTED_NAME = 'expected.json'


class OutputError(Exception):
    """A write would leave the outputs folder or land in a protected folder."""


def protection_of(folder: Path, fixtures: list[Path]) -> str | None:
    """Why a folder is protected, or None when it is not."""
    real = folder.resolve()
    for fixture in fixtures:
        if real == fixture:
            return 'it is the fixtures folder'
    if not real.is_dir():
        return None
    if (real / DUMP_MANIFEST_NAME).is_file():
        return f'it holds {DUMP_MANIFEST_NAME}, so it is an evidence folder'
    try:
        names = [child for child in real.iterdir() if child.name.endswith(CAPTURE_MANIFEST_SUFFIX)]
    except OSError:
        # A folder that this user cannot list holds no evidence of this user.
        names = []
    if any(child.is_file() for child in names):
        return f'it holds a *{CAPTURE_MANIFEST_SUFFIX} file, so it is an evidence folder'
    if (real / EXPECTED_NAME).is_file():
        return f'it holds {EXPECTED_NAME}, so it is a fixtures folder'
    return None


class OutputDir:
    """The outputs folder of one run. Each write goes through it."""

    def __init__(self, folder, fixtures=None):
        """Checks the folder and makes it when it is missing.

        `fixtures` is the fixtures folder, or a list of them, that the run reads.
        Raises `OutputError` when the folder is protected or lies in a
        protected folder.
        """
        if folder is None or str(folder) == '':
            raise OutputError('no outputs folder was given. Name a folder outside each evidence folder.')
        if fixtures is None:
            fixtures = []
        elif isinstance(fixtures, (str, Path)):
            fixtures = [fixtures]
        self._fixtures = [Path(f).resolve() for f in fixtures]
        self.root = Path(folder).resolve()
        self._refuse_protected(self.root, self.root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _refuse_protected(self, start: Path, shown: Path, stop: Path | None = None) -> None:
        current = start
        while True:
            reason = protection_of(current, self._fixtures)
            if reason is not None:
                raise OutputError(
                    f'{shown}: the outputs may not go into {current}, because {reason}. '
                    'Name an outputs folder outside each evidence folder and outside the fixtures folder.'
                )
            if current == stop or current.parent == current:
                return
            current = current.parent

    def path(self, name) -> Path:
        """The real path of a file in the outputs folder, after the checks.

        Raises `OutputError` when the name leaves the folder or reaches a
        protected folder inside it.
        """
        relative = Path(name)
        if relative.is_absolute() or relative.drive or '..' in relative.parts or not relative.parts:
            raise OutputError(f'{name}: an output name must be a relative path inside the outputs folder.')
        target = (self.root / relative).resolve()
        try:
            target.relative_to(self.root)
        except ValueError:
            raise OutputError(f'{name}: the path leaves the outputs folder {self.root}.') from None
        if target.is_dir():
            raise OutputError(f'{target}: a folder holds this name; give a file name.')
        self._refuse_protected(target.parent, target, stop=self.root)
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def write_text(self, name, text: str) -> Path:
        target = self.path(name)
        with open(target, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        return target

    def write_json(self, name, value) -> Path:
        """Writes indented JSON with a trailing newline, as the scripts always did."""
        return self.write_text(name, json.dumps(value, indent=2, ensure_ascii=False) + '\n')

    def write_csv(self, name, fieldnames, rows) -> Path:
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=fieldnames, lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
        return self.write_text(name, buffer.getvalue())
