"""The SHA-256 check of evidence files against their manifest.

`dump_nodes`, `dump_journal` and `save_screenshots` each return a manifest and
write it to disk beside the files: the path, the size, and the SHA-256 of each
file. A script reads an evidence file only through `Manifest.read_verified`,
which reads the bytes one time, checks them against the manifest, and returns
them. A mismatch raises `ManifestError`, and the script stops: the file is not
the file that the bridge wrote.

A dump manifest is `manifest.json` in the dump folder, and each path is
`<outputPath>/<name>`. A journal dump is a dump in this sense: its one file is
`<outputPath>/journal.json`, of `kind: "journal"`. A capture manifest is
`save_screenshots-<UTC time>.manifest.json` beside the first capture, and each
path is relative to the output root, as its `manifestPath` is. Both resolve
against the folder that holds the manifest now, so a copied evidence folder
still checks.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path, PurePosixPath

DUMP_MANIFEST_NAME = 'manifest.json'
CAPTURE_MANIFEST_SUFFIX = '.manifest.json'
JOURNAL_TOOL = 'dump_journal'
JOURNAL_FILE_NAME = 'journal.json'
JOURNAL_FILE_KIND = 'journal'
GENESIS_HASH = '0' * 64
"""The `prevHash` of the first entry of a journal, and the head of an empty one."""

_SHA256 = re.compile(r'[0-9a-f]{64}')
_SURROGATE = re.compile('[\ud800-\udfff]')


class ManifestError(Exception):
    """An evidence file does not match its manifest, or a manifest is not usable."""


def sha256_bytes(data: bytes) -> str:
    """The SHA-256 of the exact bytes, as 64 lowercase hexadecimal characters."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    """The SHA-256 of the exact bytes of a file."""
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value) -> str:
    """The canonical JSON text of the bridge (`canonicalJson` in `server/src/evidence.ts`).

    Object keys sorted by UTF-16 code unit, arrays in their order, no
    whitespace, no trailing newline, and numbers and strings as
    `JSON.stringify` writes them. The bytes of a `dump_nodes` file are this
    text as UTF-8.
    """
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(canonical_json(item) for item in value) + ']'
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: key.encode('utf-16-be', 'surrogatepass'))
        return '{' + ','.join(f'{_js_string(key)}:{canonical_json(value[key])}' for key in keys) + '}'
    raise TypeError(f'canonical_json cannot write a value of the type {type(value).__name__}')


def canonical_sha256(value) -> str:
    """The SHA-256 of the canonical JSON of a value, as UTF-8."""
    return sha256_bytes(canonical_json(value).encode('utf-8'))


def _js_string(text: str) -> str:
    # json.dumps escapes the same characters as JSON.stringify, but it leaves a
    # lone surrogate raw, where JSON.stringify writes it as an escape.
    return _SURROGATE.sub(lambda m: f'\\u{ord(m.group()):04x}', json.dumps(text, ensure_ascii=False))


def _js_number(number: float) -> str:
    """A float as `Number.prototype.toString` writes it."""
    if number != number or number in (float('inf'), float('-inf')):
        raise ValueError('canonical_json cannot write NaN or an infinity: JSON has no such number')
    if number == 0:
        return '0'
    sign = '-' if number < 0 else ''
    # repr gives the shortest digits that read back as the same float, which
    # are the digits that JavaScript writes.
    _, digit_tuple, exponent = Decimal(repr(abs(number))).normalize().as_tuple()
    digits = ''.join(str(d) for d in digit_tuple)
    k = len(digits)
    n = exponent + k
    if k <= n <= 21:
        text = digits + '0' * (n - k)
    elif 0 < n <= 21:
        text = f'{digits[:n]}.{digits[n:]}'
    elif -6 < n <= 0:
        text = '0.' + '0' * -n + digits
    else:
        e = n - 1
        mantissa = digits if k == 1 else f'{digits[0]}.{digits[1:]}'
        text = f'{mantissa}e{"+" if e > 0 else "-"}{abs(e)}'
    return sign + text


@dataclass(frozen=True)
class ManifestEntry:
    """One evidence file that a manifest lists."""

    local_path: Path
    """Where the file is now."""
    listed_path: str
    """The path as the manifest writes it."""
    sha256: str
    size: int | None
    record: dict
    """The whole entry of the manifest."""


class Manifest:
    """A manifest of `dump_nodes`, `dump_journal` or `save_screenshots`, with the local path of each file."""

    def __init__(self, path: Path, data: dict, base: Path, entries: tuple[ManifestEntry, ...]):
        self.path = path
        self.data = data
        self.base = base
        self.entries = entries

    @property
    def tool(self) -> str | None:
        return self.data.get('tool')

    def entry_for(self, local_path) -> ManifestEntry | None:
        """The entry of a file, found by its local path."""
        target = _same_path_key(local_path)
        for entry in self.entries:
            if _same_path_key(entry.local_path) == target:
                return entry
        return None

    def journal_entry(self) -> ManifestEntry:
        """The one file of a `dump_journal` manifest.

        Raises `ManifestError` when this is the manifest of another tool.
        """
        if self.tool != JOURNAL_TOOL or len(self.entries) != 1:
            raise ManifestError(
                f'{self.path}: this is not the manifest of a dump_journal call (its tool is '
                f'{self.tool!r}). Give the folder that dump_journal wrote, or its {DUMP_MANIFEST_NAME}.'
            )
        return self.entries[0]

    def read_verified(self, entry: ManifestEntry) -> bytes:
        """Reads a listed file one time and checks its size and its SHA-256.

        Raises `ManifestError` when the file is missing or does not match.
        """
        try:
            data = entry.local_path.read_bytes()
        except FileNotFoundError:
            raise ManifestError(
                f'{entry.local_path}: the file is missing, but the manifest {self.path} lists it '
                f'as {entry.listed_path}. Use the evidence folder as the bridge wrote it.'
            ) from None
        if entry.size is not None and len(data) != entry.size:
            raise ManifestError(
                f'{entry.local_path}: the file has {len(data)} bytes, but the manifest {self.path} '
                f'gives {entry.size}. The file changed after the bridge wrote it; do not use it as evidence.'
            )
        observed = sha256_bytes(data)
        if observed != entry.sha256:
            raise ManifestError(
                f'{entry.local_path}: the SHA-256 is {observed}, but the manifest {self.path} gives '
                f'{entry.sha256}. The file changed after the bridge wrote it; do not use it as evidence.'
            )
        return data

    def verify_all(self) -> None:
        """Checks each listed file. Raises `ManifestError` at the first mismatch."""
        for entry in self.entries:
            self.read_verified(entry)


def load_manifest(path) -> Manifest:
    """Reads a manifest and resolves the local path of each file it lists.

    Raises `ManifestError` when the file is not a manifest of the bridge, or
    when an entry leaves the evidence folder.
    """
    path = Path(path)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raise ManifestError(f'{path}: the manifest is missing.') from None
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ManifestError(f'{path}: the manifest is not valid JSON: {err}') from None
    if not isinstance(data, dict) or not isinstance(data.get('files'), list):
        raise ManifestError(f'{path}: this is not a manifest of the bridge: it has no files list.')

    folder = path.resolve().parent
    if 'outputPath' in data:
        local_of, base = _dump_paths(path, data, folder)
    elif 'manifestPath' in data:
        local_of, base = _capture_paths(path, data, folder)
    else:
        raise ManifestError(
            f'{path}: the manifest has neither outputPath (dump_nodes) nor manifestPath '
            '(save_screenshots), so its paths cannot be resolved.'
        )

    entries = []
    for index, record in enumerate(data['files']):
        at = f'{path}: files[{index}]'
        if not isinstance(record, dict):
            raise ManifestError(f'{at} is not an object.')
        if record.get('ok') is False:
            # A capture item that failed has no file.
            continue
        listed = record.get('path')
        sha = record.get('sha256')
        if not isinstance(listed, str) or not isinstance(sha, str) or not _SHA256.fullmatch(sha):
            raise ManifestError(f'{at} has no path or no SHA-256 of 64 hexadecimal characters.')
        local = local_of(listed, at)
        if not _is_inside(local, base):
            raise ManifestError(f'{at}: the path {listed} leaves the evidence folder {base}.')
        size = record.get('bytes')
        entries.append(
            ManifestEntry(
                local_path=local,
                listed_path=listed,
                sha256=sha,
                size=size if isinstance(size, int) and not isinstance(size, bool) else None,
                record=record,
            )
        )
    if data.get('tool') == JOURNAL_TOOL:
        _check_journal_files(path, entries)
    return Manifest(path, data, base, tuple(entries))


def _check_journal_files(path: Path, entries: list[ManifestEntry]) -> None:
    """A journal dump lists one file: `journal.json`, of kind `journal`."""
    if len(entries) != 1:
        raise ManifestError(
            f'{path}: a dump_journal manifest lists one file, but this one lists {len(entries)}. '
            'Use the manifest as the bridge wrote it.'
        )
    entry = entries[0]
    if entry.record.get('kind') != JOURNAL_FILE_KIND or entry.local_path.name != JOURNAL_FILE_NAME:
        raise ManifestError(
            f'{path}: the file of a dump_journal manifest must be {JOURNAL_FILE_NAME} of the kind '
            f'{JOURNAL_FILE_KIND}, but the manifest lists {entry.listed_path} of the kind '
            f'{entry.record.get("kind")!r}. Use the manifest as the bridge wrote it.'
        )


def _dump_paths(path: Path, data: dict, folder: Path):
    if path.name != DUMP_MANIFEST_NAME:
        raise ManifestError(f'{path}: a dump manifest must be named {DUMP_MANIFEST_NAME}.')
    prefix = data['outputPath']
    if not isinstance(prefix, str):
        raise ManifestError(f'{path}: outputPath is not a string.')
    prefix = prefix.rstrip('/')

    def local_of(listed: str, at: str) -> Path:
        if prefix in ('', '.'):
            rest = listed
        elif listed.startswith(prefix + '/'):
            rest = listed[len(prefix) + 1 :]
        else:
            raise ManifestError(f'{at}: the path {listed} is not in the outputPath {prefix}.')
        return folder / _relative_parts(rest, at)

    return local_of, folder


def _capture_paths(path: Path, data: dict, folder: Path):
    own = data['manifestPath']
    if not isinstance(own, str):
        raise ManifestError(f'{path}: manifestPath is not a string.')
    parts = PurePosixPath(own).parts
    if not parts or parts[-1] != path.name:
        raise ManifestError(
            f'{path}: the manifest names itself {own}; it was renamed or moved away from its captures.'
        )
    base = folder
    for _ in parts[:-1]:
        base = base.parent

    def local_of(listed: str, at: str) -> Path:
        return base / _relative_parts(listed, at)

    return local_of, base


def _relative_parts(listed: str, at: str) -> Path:
    pure = PurePosixPath(listed)
    if (
        not listed
        or '\\' in listed
        or pure.is_absolute()
        or '..' in pure.parts
        or (pure.parts and ':' in pure.parts[0])
    ):
        raise ManifestError(f'{at}: the path {listed} is not a plain relative path.')
    return Path(*pure.parts)


def _is_inside(path: Path, folder: Path) -> bool:
    try:
        path.resolve().relative_to(folder.resolve())
    except ValueError:
        return False
    return True


def _same_path_key(path) -> str:
    return os.path.normcase(str(Path(path).resolve()))
