#!/usr/bin/env python3
"""census.py — the binding census and the layout audit of a dump.

For one root it reports:

- the unbound SOLID paints, by colour, with the exemptions of an explicit list;
- the radius-bearing nodes, and how many bind a radius. Figma spreads a
  `cornerRadius` binding across the four corners, so the census reads the
  bindings of `topLeftRadius` to `bottomRightRadius`;
- the raw non-zero gaps and paddings, and which of them are off the spacing
  scale. A zero gap or padding is not counted;
- the bindings to the theme collections outside the exempt subtrees;
- the nested shortfalls of a cut `get_node` read.

`instanced-sets` lists each component set that is instanced on the roots it
reads.

The figures use the visible content: the baseline as it is, or the visible
projection of a `dump_nodes` dump, so that the figures of both formats
compare. The hidden content of a `dump_nodes` dump goes in `hidden_content`
and in the findings rows whose category starts with `hidden_`.
"""

import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.config import load_config  # noqa: E402
from auditlib.dumps import (  # noqa: E402
    FORMAT_DUMP_NODES,
    DumpError,
    is_hidden_node,
    load_all_roots,
    load_dump,
    load_json,
    load_variables,
)
from auditlib.outputs import OutputDir  # noqa: E402
from completeness import check_node_completeness  # noqa: E402

CORNER_KEYS = {'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'}

FINDING_FIELDS = ['node_id', 'type', 'field', 'value', 'category']
INSTANCED_SET_FIELDS = ['component_set_id', 'component_set_name', 'instance_count', 'pages']


def build_var_collection_map(vars_data):
    """Map variable ID -> collection name."""
    vmap = {}
    for col in vars_data.get('collections', []):
        cname = col.get('name', '')
        for v in col.get('variables', []):
            vid = v['id']
            vmap[vid] = cname
            if vid.startswith('VariableID:'):
                vmap[vid.split(':', 1)[1]] = cname
    return vmap


def build_spacing_scale(vars_data, collection_name):
    """The default-mode numbers of the spacing collection."""
    scale = set()
    for col in vars_data.get('collections', []):
        if col.get('name') == collection_name:
            dm = col.get('defaultModeId')
            for v in col.get('variables', []):
                val = v.get('valuesByMode', {}).get(dm)
                if isinstance(val, (int, float)):
                    scale.add(val)
    return scale


def rgb_hex(color_str):
    """Normalise hex color."""
    if isinstance(color_str, str):
        return color_str.lower()
    return str(color_str).lower()


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def audit_unbound_paints(root, unbound_exemptions):
    """Find all unbound SOLID paints.

    A paint counts as bound when the node-level `boundVariables` list of its
    field has an entry at its index. That list leaves out the unbound paints,
    so the rule can miss a bound paint after an unbound one; it is kept so that
    the figures stay those of the baseline.
    """
    results = []

    def walk(node):
        nid = node.get('id', '')
        bv = node.get('boundVariables', {})
        styles = node.get('styles', {})
        is_exempt = nid in unbound_exemptions

        for field, bv_key in [('fills', 'fills'), ('strokes', 'strokes')]:
            paints = styles.get(field, [])
            bv_list = bv.get(bv_key, [])
            if not paints or paints == 'mixed':
                continue
            for idx, p in enumerate(paints):
                if p.get('type') != 'SOLID':
                    continue
                is_bound = False
                if isinstance(bv_list, list) and idx < len(bv_list) and bv_list[idx]:
                    is_bound = True
                elif isinstance(bv_list, str) and bv_list:
                    is_bound = True
                if not is_bound:
                    results.append(_paint_row(nid, field, idx, p, is_exempt, unbound_exemptions))
        for c in node.get('children', []):
            walk(c)

    walk(root)
    return results


def _paint_row(nid, field, idx, paint, is_exempt, unbound_exemptions):
    return {
        'node_id': nid,
        'field': field,
        'index': idx,
        'color': rgb_hex(paint.get('color', '')),
        'exempt': is_exempt,
        'reason': unbound_exemptions.get(nid, ''),
    }


def audit_hidden_unbound_paints(hidden, unbound_exemptions):
    """The unbound SOLID paints of the hidden content: each paint of a hidden node, and each hidden paint.

    A dump gives each paint its own `boundVariables`, so here a paint counts
    as bound when it carries one.
    """
    results = []

    def check(node, field, idx, paint):
        if not isinstance(paint, dict) or paint.get('type') != 'SOLID' or paint.get('boundVariables'):
            return
        nid = node.get('id', '')
        results.append(_paint_row(nid, field, idx, paint, nid in unbound_exemptions, unbound_exemptions))

    for node, field, idx, paint in hidden.paints:
        check(node, field, idx, paint)
    for node, _ancestors in hidden.nodes():
        styles = node.get('styles', {})
        for field in ('fills', 'strokes'):
            paints = styles.get(field, [])
            if not paints or paints == 'mixed':
                continue
            for idx, p in enumerate(paints):
                check(node, field, idx, p)
    return results


def audit_radius(root):
    results = []

    def walk(node):
        nid = node.get('id', '')
        styles = node.get('styles', {})
        bv = node.get('boundVariables', {})
        # A node whose corners differ reads cornerRadius "mixed", and its
        # corners in cornerRadii, a list or an object of four numbers.
        cr = _number(styles.get('cornerRadius', 0) or 0)
        radii = styles.get('cornerRadii', []) or []
        if isinstance(radii, dict):
            radii = list(radii.values())
        has_cr = cr > 0 or any(isinstance(r, (int, float)) and r > 0 for r in radii)
        bound_keys = [k for k in CORNER_KEYS if k in bv and bv[k]]
        is_bound = len(bound_keys) > 0
        is_bearing = has_cr or is_bound
        if is_bearing:
            results.append({'node_id': nid, 'is_bound': is_bound, 'bound_keys': bound_keys})
        for c in node.get('children', []):
            walk(c)

    walk(root)
    return results


def audit_spacing(root, spacing_scale):
    raw_nonzero = []

    def walk(node):
        nid = node.get('id', '')
        styles = node.get('styles', {})
        bv = node.get('boundVariables', {})
        al = styles.get('autoLayout')
        padding = styles.get('padding', {})

        if al:
            gap = al.get('gap')
            if gap is not None:
                if 'itemSpacing' in bv and bv['itemSpacing']:
                    pass
                elif gap != 0:
                    raw_nonzero.append((nid, 'gap', gap, gap in spacing_scale))

        if padding:
            for pkey, bkey in [
                ('top', 'paddingTop'),
                ('right', 'paddingRight'),
                ('bottom', 'paddingBottom'),
                ('left', 'paddingLeft'),
            ]:
                pval = padding.get(pkey)
                if pval is not None:
                    if bkey in bv and bv[bkey]:
                        pass
                    elif pval != 0:
                        raw_nonzero.append((nid, pkey, pval, pval in spacing_scale))
        for c in node.get('children', []):
            walk(c)

    walk(root)
    return raw_nonzero


def audit_theme_bindings(root, var_col_map, theme_exempt_ids, flagged_collections, in_exempt=False):
    """Flag bound-variable entries from the flagged collections outside exempt subtrees."""
    flagged = []

    def walk(node, in_exempt):
        nid = node.get('id', '')
        is_exempt = in_exempt or (nid in theme_exempt_ids)
        bv = node.get('boundVariables', {})
        if not is_exempt:
            for prop, val in bv.items():
                entries = []
                if isinstance(val, list):
                    entries = [(prop, i, v) for i, v in enumerate(val) if v]
                elif isinstance(val, str) and val:
                    entries = [(prop, 0, val)]
                elif isinstance(val, dict):
                    vid = val.get('id')
                    if vid:
                        entries = [(prop, 0, vid)]
                for prop_name, idx, vid in entries:
                    if isinstance(vid, dict):
                        vid = vid.get('id', '')
                    col_name = var_col_map.get(vid, '')
                    if col_name in flagged_collections:
                        flagged.append(
                            {'node_id': nid, 'field': prop_name, 'index': idx, 'var_id': vid, 'collection': col_name}
                        )
        for c in node.get('children', []):
            walk(c, is_exempt)

    walk(root, in_exempt)
    return flagged


def _off_scale_values(off_scale):
    counts = Counter(s[2] for s in off_scale)
    return {str(int(k) if k == int(k) else k): v for k, v in sorted(counts.items())}


def _radius_figures(radii):
    bearing = len(radii)
    bound = sum(1 for r in radii if r['is_bound'])
    return {'bearing': bearing, 'bound': bound, 'raw': bearing - bound}


def _spacing_figures(raw_sp):
    off_scale = [s for s in raw_sp if not s[3]]
    return {
        'raw_nonzero': len(raw_sp),
        'on_scale': sum(1 for s in raw_sp if s[3]),
        'off_scale': len(off_scale),
        'off_scale_values': _off_scale_values(off_scale),
    }


def _findings(paints, radii, raw_sp, theme_flags, prefix=''):
    rows = []
    for p in paints:
        if not p['exempt']:
            rows.append(
                {
                    'node_id': p['node_id'],
                    'type': 'paint',
                    'field': p['field'],
                    'value': p['color'],
                    'category': f'{prefix}unbound_paint',
                }
            )
    for r in radii:
        if not r['is_bound']:
            rows.append(
                {
                    'node_id': r['node_id'],
                    'type': 'radius',
                    'field': 'cornerRadius',
                    'value': '',
                    'category': f'{prefix}raw_radius',
                }
            )
    for s in raw_sp:
        if not s[3]:
            rows.append(
                {
                    'node_id': s[0],
                    'type': 'spacing',
                    'field': s[1],
                    'value': str(s[2]),
                    'category': f'{prefix}raw_spacing_off_scale',
                }
            )
    for t in theme_flags:
        rows.append(
            {
                'node_id': t['node_id'],
                'type': 'binding',
                'field': t['field'],
                'value': t['var_id'],
                'category': f'{prefix}theme_or_raw_binding',
            }
        )
    return rows


def run_census(dump, vars_data, exemptions, config):
    """The census of one root: the content of `<label>.census.json`, and the findings rows."""
    spacing_collection = config.require('spacing_collection', 'census.py')
    theme_collections = set(config.require('theme_collections', 'census.py'))
    unbound_exempt = exemptions.get('unbound_paint', {})
    theme_exempt = exemptions.get('theme_binding_subtree', {})
    var_col_map = build_var_collection_map(vars_data)
    spacing_scale = build_spacing_scale(vars_data, spacing_collection)

    visible = dump.visible()
    paints = audit_unbound_paints(visible, unbound_exempt)
    unexempt = [p for p in paints if not p['exempt']]
    radii = audit_radius(visible)
    raw_sp = audit_spacing(visible, spacing_scale)
    theme_flags = audit_theme_bindings(visible, var_col_map, theme_exempt, theme_collections)

    census = {
        'root_id': visible.get('id'),
        'root_name': visible.get('name'),
        'unbound_paints': {
            'count': len(unexempt),
            'colours': dict(Counter(p['color'] for p in unexempt)),
            'exempt': sum(1 for p in paints if p['exempt']),
            'total': len(paints),
            'colours_all': dict(Counter(p['color'] for p in paints)),
        },
        'radius': _radius_figures(radii),
        'spacing': _spacing_figures(raw_sp),
        'theme_or_raw_binding_entries_outside_exemptions': len(theme_flags),
        'nested_shortfalls': check_node_completeness(visible),
        'source': dump.source(),
        'hidden_content': None,
    }
    findings = _findings(paints, radii, raw_sp, theme_flags)

    hidden = dump.hidden()
    if hidden is not None:
        h_paints = audit_hidden_unbound_paints(hidden, unbound_exempt)
        h_unexempt = [p for p in h_paints if not p['exempt']]
        h_radii = []
        h_raw_sp = []
        h_theme = []
        for top, ancestors in hidden.subtrees:
            h_radii += audit_radius(top)
            h_raw_sp += audit_spacing(top, spacing_scale)
            in_exempt = any(a.get('id') in theme_exempt for a in ancestors)
            h_theme += audit_theme_bindings(top, var_col_map, theme_exempt, theme_collections, in_exempt)
        census['hidden_content'] = {
            'nodes': hidden.node_count,
            'paints': len(hidden.paints),
            'unbound_paints': {
                'count': len(h_unexempt),
                'colours': dict(Counter(p['color'] for p in h_unexempt)),
                'exempt': sum(1 for p in h_paints if p['exempt']),
            },
            'radius': _radius_figures(h_radii),
            'spacing': _spacing_figures(h_raw_sp),
            'theme_or_raw_binding_entries_outside_exemptions': len(h_theme),
        }
        findings += _findings(h_paints, h_radii, h_raw_sp, h_theme, prefix='hidden_')
    return census, findings


def figures(dump, vars_data, exemptions, config):
    """The census figures of one root, for the self-check."""
    return run_census(dump, vars_data, exemptions, config)[0]


def cmd_audit(args):
    outputs = OutputDir(args.outputs, args.fixtures)
    dump = load_dump(args.dump_path, args.root, args.format)
    census, findings = run_census(dump, load_variables(args.vars), load_json(args.exemptions), load_config(args.config))

    label = args.label
    outputs.write_json(f'{label}.census.json', census)
    outputs.write_csv(f'{label}.findings.csv', FINDING_FIELDS, findings)

    up = census['unbound_paints']
    r = census['radius']
    sp = census['spacing']
    print(f'Census audit: {label}')
    print(f'  Unbound paints: {up["count"]} (exempt: {up["exempt"]})')
    print(f'  Radius: {r["bearing"]} bearing, {r["bound"]} bound, {r["raw"]} raw')
    print(f'  Spacing: {sp["raw_nonzero"]} raw_nonzero, {sp["on_scale"]} on_scale, {sp["off_scale"]} off_scale')
    print(f'  Theme/raw bindings outside exemptions: {census["theme_or_raw_binding_entries_outside_exemptions"]}')
    print(f'  Nested shortfalls: {len(census["nested_shortfalls"])}')
    hidden = census['hidden_content']
    if hidden is not None:
        hu, hr, hs = hidden['unbound_paints'], hidden['radius'], hidden['spacing']
        print(f'  Hidden content, not in the figures above: {hidden["nodes"]} nodes, {hidden["paints"]} hidden paints')
        print(f'    Hidden unbound paints: {hu["count"]} (exempt: {hu["exempt"]})')
        print(f'    Hidden radius: {hr["bearing"]} bearing, {hr["bound"]} bound, {hr["raw"]} raw')
        print(f'    Hidden spacing: {hs["raw_nonzero"]} raw_nonzero, {hs["off_scale"]} off_scale')
        print(f'    Hidden theme/raw bindings: {hidden["theme_or_raw_binding_entries_outside_exemptions"]}')
    elif dump.format == FORMAT_DUMP_NODES:
        print('  Hidden content: not dumped (includeHidden was false); this dump is not audit evidence.')
    return cli.EXIT_OK


def _set_names(components):
    if isinstance(components, dict):
        return {item['id']: item.get('name', '') for item in components.get('items', []) if 'id' in item}
    return {}


def instanced_sets(dumps, cache, components):
    """Each component set with its instance count and the roots it appears on, visible and hidden apart."""
    names = _set_names(components)
    counts = {
        'visible': defaultdict(lambda: {'name': '', 'count': 0, 'pages': set()}),
        'hidden': defaultdict(lambda: {'name': '', 'count': 0, 'pages': set()}),
    }

    def set_of(inst, dump):
        iid = inst.get('id')
        data = cache.get(iid) or {}
        mc = data.get('mainComponent', {}) if isinstance(data, dict) else {}
        if dump.format == FORMAT_DUMP_NODES:
            psid = inst.get('componentSetId')
            return psid, names.get(psid) or mc.get('parentSetName') or ''
        return mc.get('parentSetId'), mc.get('parentSetName') or names.get(mc.get('parentSetId')) or ''

    def add(kind, inst, dump, page_name):
        psid, psname = set_of(inst, dump)
        if psid:
            entry = counts[kind][psid]
            entry['name'] = psname or entry['name']
            entry['count'] += 1
            entry['pages'].add(page_name)

    for dump in dumps:
        page_name = dump.root.get('name', dump.path.stem)
        # The full tree, not the projection: the projection drops componentSetId.
        # A baseline dump counts each instance it holds, as the earlier script did.
        split = dump.has_hidden_content

        def find_instances(n, in_hidden):
            hidden_here = split and (in_hidden or (n is not dump.root and is_hidden_node(n)))
            if n.get('type') == 'INSTANCE':
                add('hidden' if hidden_here else 'visible', n, dump, page_name)
            for c in n.get('children', []):
                find_instances(c, hidden_here)

        find_instances(dump.root, False)

    def rows(kind):
        return [
            {
                'component_set_id': sid,
                'component_set_name': info['name'],
                'instance_count': info['count'],
                'pages': '; '.join(sorted(info['pages'])),
            }
            for sid, info in sorted(counts[kind].items(), key=lambda x: -x[1]['count'])
        ]

    return rows('visible'), rows('hidden')


def cmd_instanced_sets(args):
    outputs = OutputDir(args.outputs, args.fixtures)
    dumps = [dump for path in args.dumps for dump in load_all_roots(path, args.format)]
    if args.cache is None and any(dump.format != FORMAT_DUMP_NODES for dump in dumps):
        raise DumpError('a baseline dump names no component set; give --cache with the get_instance results.')
    cache = load_json(args.cache) if args.cache else {}
    components = load_json(args.components) if args.components else None
    visible_rows, hidden_rows = instanced_sets(dumps, cache, components)

    name = Path(args.out_name)
    outputs.write_csv(name, INSTANCED_SET_FIELDS, visible_rows)
    print(f'Wrote {len(visible_rows)} component sets to {outputs.root / name}')
    if any(dump.has_hidden_content for dump in dumps):
        hidden_name = name.with_name(f'{name.stem}.hidden{name.suffix}')
        outputs.write_csv(hidden_name, INSTANCED_SET_FIELDS, hidden_rows)
        print(f'Wrote {len(hidden_rows)} component sets instanced in hidden content to {outputs.root / hidden_name}')
    return cli.EXIT_OK


def main():
    parser = argparse.ArgumentParser(description='Design system binding census')
    sub = parser.add_subparsers(dest='command', required=True)

    p_audit = sub.add_parser('audit', help='Run the census on one root of a dump')
    p_audit.add_argument('dump_path', help='A dump folder, a file in one, or a baseline file')
    cli.add_dump_options(p_audit)
    p_audit.add_argument('--label', required=True, help='The name prefix of the output files')
    p_audit.add_argument('--vars', required=True, help='A get_variable_defs payload, or a dump folder with variables.json')
    p_audit.add_argument('--exemptions', required=True, help='The exemptions JSON')
    p_audit.add_argument('--config', required=True, help='The configuration with the collection names')
    cli.add_outputs_option(p_audit)

    p_inst = sub.add_parser('instanced-sets', help='List the instanced component sets')
    p_inst.add_argument('--dumps', nargs='+', required=True, help='Dump folders or files')
    p_inst.add_argument('--cache', default=None, help='The get_instance results by instance ID; needed for a baseline dump')
    p_inst.add_argument('--components', default=None, help='A list_components result, for the set names')
    p_inst.add_argument('--format', choices=['baseline', 'dump_nodes'], default=None, help='Force the format')
    p_inst.add_argument('--out-name', default='instanced_sets.csv', help='The output file name')
    cli.add_outputs_option(p_inst)

    args = parser.parse_args()
    if args.command == 'audit':
        return cmd_audit(args)
    return cmd_instanced_sets(args)


if __name__ == '__main__':
    cli.run(main)
