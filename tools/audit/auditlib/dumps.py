"""The loaders of node dumps, and the one node model of the scripts.

Two formats exist:

- The baseline format: one JSON file that holds a `get_node` result, saved
  before `dump_nodes` existed. It holds no hidden content, and no manifest
  lists it.
- The `dump_nodes` format: a folder with `manifest.json` and one canonical
  JSON file for each root (`12:34` gives `12_34.json`). It holds the hidden
  content, marked `visible: false`, and the fields that only a dump adds.
  Each file is read through its manifest, which checks its SHA-256.

Both give the same node model: a dict with the field names of the dump form
(`plugin/src/main/dump.ts`), which extends the read form of `get_node`:
`id`, `name`, `type`, `bounds`, `styles`, `boundVariables`, `characters`,
`textStyleId`, `componentProperties`, `children`, and in a dump also
`mainComponentId`, `componentSetId`, `detachedInfo`, `reactions`,
`flowStartingPoints`, `styledTextSegments`, and `boundVariables` inside a
paint. A field that is absent holds the default of Figma.

`Dump.visible()` gives the tree that the figures of the scripts use: the
baseline tree as it is, or the visible projection of a `dump_nodes` tree, the
same projection as the conformance test (`server/scripts/conformance.ts`).
Thus a figure of a `dump_nodes` dump compares with the same figure of a
baseline read. `Dump.hidden()` gives the hidden content for the separate rows.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .manifest import DUMP_MANIFEST_NAME, Manifest, ManifestError, load_manifest, sha256_bytes

FORMAT_BASELINE = 'baseline'
FORMAT_DUMP_NODES = 'dump_nodes'

DUMP_ADDED_FIELDS = (
    'mainComponentId',
    'componentSetId',
    'detachedInfo',
    'reactions',
    'flowStartingPoints',
    'styledTextSegments',
)
"""The fields that a dump adds to a node, and that `get_node` does not write."""

PAINT_FIELDS = ('fills', 'strokes')


class DumpError(Exception):
    """A dump cannot be read: a missing file, a wrong root, or a refused format."""


def is_hidden_node(node) -> bool:
    """True for a node with `styles.visible: false`."""
    styles = node.get('styles') if isinstance(node, dict) else None
    return isinstance(styles, dict) and styles.get('visible') is False


def is_hidden_entry(entry) -> bool:
    """True for a paint or an effect with `visible: false`."""
    return isinstance(entry, dict) and entry.get('visible') is False


def children_of(node) -> list:
    children = node.get('children') if isinstance(node, dict) else None
    return children if isinstance(children, list) else []


def iter_tree(root):
    """Each node of a tree in pre-order, with the list of its ancestors."""
    stack = [(root, [])]
    while stack:
        node, ancestors = stack.pop()
        yield node, ancestors
        below = ancestors + [node]
        for child in reversed(children_of(node)):
            stack.append((child, below))


def visible_projection(node: dict) -> dict:
    """The visible projection of a dumped node and its subtree: the `get_node` form.

    Below the node, each hidden node goes with its subtree; the node itself
    stays, as `get_node` gives a hidden root too. Each hidden paint goes, and a
    paint list that is then empty goes. Each hidden effect goes, and the
    effect list stays, also when it is then empty. The fields of
    `DUMP_ADDED_FIELDS` and the `boundVariables` of each paint go. The
    bindings of a node stay. The dump itself is not changed.
    """
    copy = {}
    for key, value in node.items():
        if key in DUMP_ADDED_FIELDS or key == 'children':
            continue
        copy[key] = _visible_styles(value) if key == 'styles' and isinstance(value, dict) else value
    if isinstance(node.get('children'), list):
        visible = [
            visible_projection(child)
            for child in node['children']
            if isinstance(child, dict) and not is_hidden_node(child)
        ]
        if visible:
            copy['children'] = visible
    return copy


def _visible_styles(styles: dict) -> dict:
    copy = dict(styles)
    for field_name in PAINT_FIELDS:
        if field_name not in copy:
            continue
        paints = copy[field_name]
        if isinstance(paints, list):
            paints = [
                {k: v for k, v in paint.items() if k != 'boundVariables'} if isinstance(paint, dict) else paint
                for paint in paints
                if not is_hidden_entry(paint)
            ]
            if not paints:
                del copy[field_name]
                continue
        copy[field_name] = paints
    if isinstance(copy.get('effects'), list):
        copy['effects'] = [effect for effect in copy['effects'] if not is_hidden_entry(effect)]
    return copy


@dataclass
class HiddenContent:
    """The hidden content of a `dump_nodes` tree, which the visible projection leaves out.

    `subtrees` holds each hidden node below the root whose ancestors are all
    visible, with those ancestors; its subtree is hidden with it. `paints` and
    `effects` hold each hidden entry of a node that stays in the projection.
    """

    subtrees: list = field(default_factory=list)
    """`(node, ancestors)` for each topmost hidden node."""
    paints: list = field(default_factory=list)
    """`(node, field, index, paint)` for each hidden paint of a visible node."""
    effects: list = field(default_factory=list)
    """`(node, index, effect)` for each hidden effect of a visible node."""

    def nodes(self):
        """Each node of the hidden subtrees, in pre-order, with its ancestors."""
        for top, above in self.subtrees:
            for node, ancestors in iter_tree(top):
                yield node, above + ancestors

    @property
    def node_count(self) -> int:
        return sum(1 for _ in self.nodes())


def hidden_content(root: dict) -> HiddenContent:
    """Splits off the hidden content of a `dump_nodes` tree."""
    found = HiddenContent()
    stack = [(root, [])]
    while stack:
        node, ancestors = stack.pop()
        if ancestors and is_hidden_node(node):
            found.subtrees.append((node, ancestors))
            continue
        styles = node.get('styles') if isinstance(node.get('styles'), dict) else {}
        for field_name in PAINT_FIELDS:
            paints = styles.get(field_name)
            if isinstance(paints, list):
                for index, paint in enumerate(paints):
                    if is_hidden_entry(paint):
                        found.paints.append((node, field_name, index, paint))
        effects = styles.get('effects')
        if isinstance(effects, list):
            for index, effect in enumerate(effects):
                if is_hidden_entry(effect):
                    found.effects.append((node, index, effect))
        below = ancestors + [node]
        for child in reversed(children_of(node)):
            if isinstance(child, dict):
                stack.append((child, below))
    return found


def dump_only_content(root: dict) -> str | None:
    """Names the first content of a tree that only `dump_nodes` writes, or None.

    A hidden node below the root, a hidden paint or effect, a field of
    `DUMP_ADDED_FIELDS`, or the `boundVariables` of a paint.
    """
    for node, ancestors in iter_tree(root):
        where = node.get('id', '?')
        if ancestors and is_hidden_node(node):
            return f'the hidden node {where}'
        for key in DUMP_ADDED_FIELDS:
            if key in node:
                return f'the field {key} on {where}'
        styles = node.get('styles') if isinstance(node.get('styles'), dict) else {}
        for field_name in PAINT_FIELDS + ('effects',):
            entries = styles.get(field_name)
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if is_hidden_entry(entry):
                    return f'a hidden entry of {field_name} on {where}'
                if isinstance(entry, dict) and 'boundVariables' in entry:
                    return f'the boundVariables of a paint on {where}'
    return None


@dataclass
class Dump:
    """One root of a dump, in either format."""

    path: Path
    """The file that was read."""
    format: str
    root: dict
    """The tree as the file holds it."""
    sha256: str
    """The SHA-256 of the file bytes."""
    manifest: Manifest | None = None
    include_hidden: bool | None = None
    """The option of the dump call; None for the baseline format."""
    _visible: dict | None = field(default=None, repr=False)
    _hidden: HiddenContent | None = field(default=None, repr=False)

    @property
    def node_id(self) -> str:
        return self.root.get('id', '')

    @property
    def name(self) -> str:
        return self.root.get('name', '')

    @property
    def has_hidden_content(self) -> bool:
        """True when the hidden rows mean something: a `dump_nodes` dump made with `includeHidden`."""
        return self.format == FORMAT_DUMP_NODES and self.include_hidden is True

    def visible(self) -> dict:
        """The tree that the figures use: the baseline as it is, or the visible projection."""
        if self.format == FORMAT_BASELINE:
            return self.root
        if self._visible is None:
            self._visible = visible_projection(self.root)
        return self._visible

    def hidden(self) -> HiddenContent | None:
        """The hidden content, or None when the dump cannot hold any (see `has_hidden_content`)."""
        if not self.has_hidden_content:
            return None
        if self._hidden is None:
            self._hidden = hidden_content(self.root)
        return self._hidden

    def source(self) -> dict:
        """The description of the input for an output file."""
        described = {'format': self.format, 'file': str(self.path), 'sha256': self.sha256}
        if self.manifest is not None:
            described['manifest'] = str(self.manifest.path)
            described['includeHidden'] = self.include_hidden
        return described


def load_dump(path, root_id: str | None = None, format: str | None = None) -> Dump:
    """Reads one root of a dump.

    `path` is a `dump_nodes` folder, a nodes file in such a folder, or a
    baseline file. A folder of more than one root needs `root_id`. A file with
    no manifest beside it is read in the baseline format, and is refused when
    it holds content that only `dump_nodes` writes: read such a file through
    its folder, so that its SHA-256 is checked. `format='baseline'` reads a
    file in an older read form that keeps hidden nodes.
    """
    path = Path(path)
    if format not in (None, FORMAT_BASELINE, FORMAT_DUMP_NODES):
        raise DumpError(f'{path}: the format {format!r} is not known; use baseline or dump_nodes.')
    if path.is_dir():
        if format == FORMAT_BASELINE:
            raise DumpError(f'{path}: a folder is a dump_nodes dump; give a baseline file instead.')
        return _load_from_folder(path, root_id)
    if not path.is_file():
        raise DumpError(f'{path}: the dump is missing.')
    if format != FORMAT_BASELINE and (path.parent / DUMP_MANIFEST_NAME).is_file():
        return _load_listed_file(path, root_id)
    if format == FORMAT_DUMP_NODES:
        raise DumpError(f'{path}: no {DUMP_MANIFEST_NAME} is beside it, so it is not a dump_nodes file.')
    return _load_baseline(path, root_id, forced=format == FORMAT_BASELINE)


def load_all_roots(path, format: str | None = None) -> list[Dump]:
    """Reads each root of a `dump_nodes` folder in the order of its manifest, or the one root of a file."""
    path = Path(path)
    if not path.is_dir():
        return [load_dump(path, format=format)]
    if format == FORMAT_BASELINE:
        raise DumpError(f'{path}: a folder is a dump_nodes dump; give a baseline file instead.')
    manifest = _open_dump_manifest(path / DUMP_MANIFEST_NAME)
    return [_read_entry(manifest, entry) for entry in manifest.entries if entry.record.get('kind') == 'nodes']


def _open_dump_manifest(path: Path) -> Manifest:
    try:
        manifest = load_manifest(path)
    except ManifestError as err:
        raise DumpError(str(err)) from None
    if manifest.tool != 'dump_nodes':
        raise DumpError(f'{path}: the manifest is of the tool {manifest.tool!r}, not of dump_nodes.')
    return manifest


def _load_from_folder(folder: Path, root_id: str | None) -> Dump:
    manifest = _open_dump_manifest(folder / DUMP_MANIFEST_NAME)
    nodes = [entry for entry in manifest.entries if entry.record.get('kind') == 'nodes']
    if root_id is not None:
        chosen = [entry for entry in nodes if entry.record.get('nodeId') == root_id]
        if not chosen:
            roots = ', '.join(str(entry.record.get('nodeId')) for entry in nodes) or 'none'
            raise DumpError(f'{folder}: the dump holds no root {root_id}. Its roots: {roots}.')
    elif len(nodes) == 1:
        chosen = nodes
    else:
        roots = ', '.join(str(entry.record.get('nodeId')) for entry in nodes) or 'none'
        raise DumpError(f'{folder}: the dump holds {len(nodes)} roots ({roots}); name one with the root option.')
    return _read_entry(manifest, chosen[0])


def _load_listed_file(path: Path, root_id: str | None) -> Dump:
    manifest = _open_dump_manifest(path.parent / DUMP_MANIFEST_NAME)
    entry = manifest.entry_for(path)
    if entry is None:
        raise DumpError(
            f'{path}: the {DUMP_MANIFEST_NAME} beside it does not list it. An evidence folder holds '
            'only the files of its manifest; move a baseline file out of it.'
        )
    if entry.record.get('kind') != 'nodes':
        raise DumpError(f'{path}: the manifest lists it as {entry.record.get("kind")!r}, not as a nodes file.')
    if root_id is not None and entry.record.get('nodeId') != root_id:
        raise DumpError(f'{path}: the file holds the root {entry.record.get("nodeId")}, not {root_id}.')
    return _read_entry(manifest, entry)


def _read_entry(manifest: Manifest, entry) -> Dump:
    try:
        data = manifest.read_verified(entry)
    except ManifestError as err:
        raise DumpError(str(err)) from None
    root = _parse_node(entry.local_path, data)
    if root.get('id') != entry.record.get('nodeId'):
        raise DumpError(
            f'{entry.local_path}: the file holds the node {root.get("id")}, but the manifest '
            f'gives the root {entry.record.get("nodeId")}.'
        )
    include_hidden = manifest.data.get('includeHidden')
    return Dump(
        path=entry.local_path,
        format=FORMAT_DUMP_NODES,
        root=root,
        sha256=entry.sha256,
        manifest=manifest,
        include_hidden=include_hidden if isinstance(include_hidden, bool) else None,
    )


def _load_baseline(path: Path, root_id: str | None, forced: bool) -> Dump:
    data = path.read_bytes()
    root = _parse_node(path, data)
    if root_id is not None and root.get('id') != root_id:
        raise DumpError(f'{path}: the file holds the root {root.get("id")}, not {root_id}.')
    if not forced:
        marker = dump_only_content(root)
        if marker is not None:
            raise DumpError(
                f'{path}: the file holds {marker}, which only dump_nodes writes, but no '
                f'{DUMP_MANIFEST_NAME} lists it. Read a dump through its folder, so that its SHA-256 '
                'is checked. For a baseline file in an older read form that keeps hidden nodes, '
                'give the format baseline.'
            )
    return Dump(path=path, format=FORMAT_BASELINE, root=root, sha256=sha256_bytes(data))


def _parse_node(path: Path, data: bytes) -> dict:
    try:
        root = json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise DumpError(f'{path}: the dump is not valid JSON: {err}') from None
    if not isinstance(root, dict) or not isinstance(root.get('id'), str) or 'type' not in root:
        raise DumpError(f'{path}: the file is not a node dump: it has no id and no type at the top.')
    return root


def load_json(path):
    """Reads a plain JSON input that no manifest lists: exemptions, a configuration, a listing."""
    path = Path(path)
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise DumpError(f'{path}: the input is missing.') from None
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise DumpError(f'{path}: the input is not valid JSON: {err}') from None


def load_variables(path) -> dict:
    """Reads a `get_variable_defs` payload: a baseline file, or `variables.json` of a dump.

    A file that a `manifest.json` beside it lists is checked against it, and so
    is the `variables.json` of a dump folder that is given as the path.
    """
    path = Path(path)
    if path.is_dir():
        manifest = _open_dump_manifest(path / DUMP_MANIFEST_NAME)
        entries = [entry for entry in manifest.entries if entry.record.get('kind') == 'variables']
        if not entries:
            raise DumpError(f'{path}: the dump holds no variables.json; dump it with includeVariables.')
        entry = entries[0]
    elif (path.parent / DUMP_MANIFEST_NAME).is_file():
        manifest = _open_dump_manifest(path.parent / DUMP_MANIFEST_NAME)
        entry = manifest.entry_for(path)
        if entry is None or entry.record.get('kind') != 'variables':
            raise DumpError(f'{path}: the {DUMP_MANIFEST_NAME} beside it does not list it as variables.')
    else:
        data = load_json(path)
        return _check_variables(path, data)
    try:
        raw = manifest.read_verified(entry)
    except ManifestError as err:
        raise DumpError(str(err)) from None
    return _check_variables(entry.local_path, json.loads(raw.decode('utf-8')))


def _check_variables(path: Path, data) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get('collections'), list):
        raise DumpError(f'{path}: this is not a get_variable_defs payload: it has no collections list.')
    return data
