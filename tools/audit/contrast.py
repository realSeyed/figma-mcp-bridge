#!/usr/bin/env python3
"""contrast.py — the WCAG 2.2 contrast audit and the contrast table of the colour foundations.

`audit` scores each visible text node of a root against its effective
background. It composites the stacked SOLID fills of the text and of its
ancestors over an opaque base: the dump itself when the stack is opaque
(`base: dump`), else the context base colour of the configuration
(`base: context`). It marks a pair "not computed" only when a non-solid fill
shows through and no opaque base exists. Normal text needs 4.5:1; large text
(24 px, or 18.66 px and bold) needs 3:1, and so does text made only of star
glyphs, which is scored as a graphical object. Text in a disabled variant is
exempt.

`table` writes the contrast table of the colour foundations from a CSV of
token pairings.

The figures use the visible content: the baseline as it is, or the visible
projection of a `dump_nodes` dump. The hidden text nodes of a `dump_nodes`
dump go in `hidden_content` and in `<label>.hidden.csv`.
"""

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auditlib import cli  # noqa: E402
from auditlib.config import load_config  # noqa: E402
from auditlib.dumps import FORMAT_DUMP_NODES, load_dump, load_variables  # noqa: E402
from auditlib.outputs import OutputDir  # noqa: E402

PAIR_FIELDS = [
    'target',
    'node_id',
    'name',
    'characters',
    'text_hex',
    'bg_hex',
    'ratio',
    'threshold',
    'base',
    'exempt',
    'status',
]
NOT_COMPUTED_FIELDS = ['target', 'node_id', 'name', 'reason']
HIDDEN_FIELDS = ['target', 'node_id', 'name', 'characters', 'reason']

# ── Colour math ──────────────────────────────────────────────────────


def hex_to_rgb(h):
    h = h.strip().lstrip('#').lower()
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hex(r, g, b):
    return f'#{int(round(r)):02x}{int(round(g)):02x}{int(round(b)):02x}'


def relative_luminance(r, g, b):
    def ch(v):
        c = v / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def wcag_ratio(hex1, hex2):
    r1, g1, b1 = hex_to_rgb(hex1)
    r2, g2, b2 = hex_to_rgb(hex2)
    l1 = relative_luminance(r1, g1, b1)
    l2 = relative_luminance(r2, g2, b2)
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


# ── Variable resolver ────────────────────────────────────────────────


class VarResolver:
    def __init__(self, vars_data):
        self.var_map = {}
        for col in vars_data.get('collections', []):
            for v in col.get('variables', []):
                self.var_map[v['id']] = (v, col)
                if v['id'].startswith('VariableID:'):
                    self.var_map[v['id'].split(':', 1)[1]] = (v, col)

    def resolve_color(self, vid):
        entry = self.var_map.get(vid)
        if not entry:
            return None
        v, col = entry
        dm = col.get('defaultModeId')
        val = v.get('valuesByMode', {}).get(dm)
        visited = {v['id']}
        alpha = 1.0

        while True:
            if isinstance(val, dict) and val.get('type') == 'VARIABLE_ALIAS':
                tid = val.get('id')
                if tid in visited or tid not in self.var_map:
                    break
                visited.add(tid)
                tv, tc = self.var_map[tid]
                val = tv.get('valuesByMode', {}).get(tc.get('defaultModeId'))
            elif (
                isinstance(val, dict)
                and 'color' in val
                and isinstance(val['color'], dict)
                and val['color'].get('type') == 'VARIABLE_ALIAS'
            ):
                tid = val['color'].get('id')
                op = val.get('opacity', 1.0)
                alpha *= op if op <= 1.0 else op / 100.0
                if tid in visited or tid not in self.var_map:
                    break
                visited.add(tid)
                tv, tc = self.var_map[tid]
                val = tv.get('valuesByMode', {}).get(tc.get('defaultModeId'))
            elif isinstance(val, dict) and val.get('type') == 'COLOR':
                r = int(round(val.get('r', 0) * 255))
                g = int(round(val.get('g', 0) * 255))
                b = int(round(val.get('b', 0) * 255))
                return (f'#{r:02x}{g:02x}{b:02x}', alpha)
            else:
                break
        return None

    def get_color(self, name_or_id):
        if name_or_id in self.var_map:
            return self.resolve_color(name_or_id)
        for vid, (v, col) in self.var_map.items():
            vname = v.get('name', '')
            if vname == name_or_id or vname.endswith(f'/{name_or_id}'):
                res = self.resolve_color(v['id'])
                if res:
                    return res
        return None


def resolve_context_base(resolver, context_base):
    """The context base as a hex colour: `#rrggbb` as given, or a variable name or ID resolved."""
    if context_base.startswith('#'):
        try:
            return rgb_to_hex(*hex_to_rgb(context_base))
        except ValueError:
            raise cli.InputError(f'the context base {context_base} is not a #rrggbb colour.') from None
    ctx = resolver.get_color(context_base)
    if not ctx:
        raise cli.InputError(
            f'cannot resolve the context base {context_base} in the variables. Give a variable name or ID '
            'of a colour, or a #rrggbb colour.'
        )
    return ctx[0]


# ── Layer compositing ────────────────────────────────────────────────


def get_paint_color(paint, bv_entry, resolver):
    if bv_entry and resolver:
        vid = bv_entry if isinstance(bv_entry, str) else (bv_entry.get('id') if isinstance(bv_entry, dict) else None)
        if vid:
            res = resolver.resolve_color(vid)
            if res:
                return (res[0], paint.get('opacity', 1.0))
    raw_color = paint.get('color', '')
    return (raw_color, paint.get('opacity', 1.0)) if raw_color else (None, 0.0)


def compute_solid_fills(node, resolver):
    styles = node.get('styles', {})
    fills = styles.get('fills', [])
    if not fills or fills == 'mixed':
        return (0.0, 0.0, 0.0), 0.0, False
    bv = node.get('boundVariables', {})
    fill_bvs = bv.get('fills', [])
    has_non_solid = False
    cur_rgb = [0.0, 0.0, 0.0]
    cur_a = 0.0
    for idx, p in enumerate(fills):
        if p.get('visible') is False:
            continue
        if p.get('type') != 'SOLID':
            has_non_solid = True
            continue
        if isinstance(fill_bvs, list) and idx < len(fill_bvs):
            bv_entry = fill_bvs[idx]
        else:
            bv_entry = fill_bvs if isinstance(fill_bvs, str) else None
        c_hex, p_a = get_paint_color(p, bv_entry, resolver)
        if not c_hex:
            continue
        r, g, b = hex_to_rgb(c_hex)
        fg_rgb = [r * p_a, g * p_a, b * p_a]
        cur_rgb = [fg_rgb[i] + cur_rgb[i] * (1.0 - p_a) for i in range(3)]
        cur_a = p_a + cur_a * (1.0 - p_a)
    return tuple(cur_rgb), cur_a, has_non_solid


def is_node_visible(node):
    styles = node.get('styles', {})
    return styles.get('visible', True) is not False and node.get('visible', True) is not False


def is_disabled(node_name, node_type, comp_props, rule):
    """True for a variant whose `rule` property has the disabled value: by its name, or by its instance properties."""
    if rule is None:
        return False
    prop, value = rule
    if node_type == 'COMPONENT' and f'{prop}={value}' in node_name:
        return True
    if node_type == 'INSTANCE' and comp_props:
        for key, val in comp_props.items():
            prop_name = key.split('#')[0] if '#' in key else key
            if prop_name == prop:
                prop_val = val.get('value', '') if isinstance(val, dict) else val
                if prop_val == value:
                    return True
    return False


def is_star_text(chars):
    if not chars:
        return False
    allowed = set('★☆ \t\n\r')
    star_chars = set('★☆')
    return all(c in allowed for c in chars) and any(c in star_chars for c in chars)


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_large_text(styles):
    """24 px, or 18.66 px and bold. A mixed size reads "mixed", and such a text counts as normal text."""
    font_size = styles.get('fontSize', 14)
    font_weight = styles.get('fontWeight', 400)
    font_style_str = styles.get('fontStyle', 'Regular')
    if not _number(font_size):
        return False
    is_bold = (_number(font_weight) and font_weight >= 700) or font_style_str in ('Bold', 'ExtraBold', 'Black', 'Heavy')
    return (font_size >= 24) or (font_size >= 18.66 and is_bold)


# ── Main audit ───────────────────────────────────────────────────────


def audit_tree(target_name, root, resolver, context_bg_hex, disabled_rule):
    pairs = []
    not_computed_list = []
    hidden_count = [0]
    ctx_rgb = hex_to_rgb(context_bg_hex)

    def walk(node, ancestors, is_hidden, is_dis):
        nid = node.get('id', '')
        nname = node.get('name', '')
        ntype = node.get('type', '')
        styles = node.get('styles', {})
        node_op = styles.get('opacity', 1.0)
        node_vis = is_node_visible(node)
        curr_hidden = is_hidden or (not node_vis)
        cp = node.get('componentProperties', {}) if ntype == 'INSTANCE' else {}
        curr_dis = is_dis or is_disabled(nname, ntype, cp, disabled_rule)

        if ntype == 'TEXT':
            if curr_hidden:
                hidden_count[0] += 1
            elif styles.get('fills') == 'mixed':
                # The fills differ by range; the pair would need each range.
                not_computed_list.append(
                    {'target': target_name, 'node_id': nid, 'name': nname, 'reason': 'mixed_text_fill'}
                )
            else:
                chars = node.get('characters', '')
                t_rgb, t_a, t_ns = compute_solid_fills(node, resolver)
                t_rgb = tuple(c * node_op for c in t_rgb)
                t_a = t_a * node_op

                if t_a < 0.001:
                    not_computed_list.append(
                        {'target': target_name, 'node_id': nid, 'name': nname, 'reason': 'no_text_fill'}
                    )
                else:
                    with_rgb = t_rgb
                    with_a = t_a
                    wo_rgb = (0.0, 0.0, 0.0)
                    wo_a = 0.0
                    has_ns_show_through = False

                    for anc in reversed(ancestors):
                        anc_op = anc.get('styles', {}).get('opacity', 1.0)
                        f_rgb, f_a, f_ns = compute_solid_fills(anc, resolver)
                        if f_ns and (wo_a < 0.999 or with_a < 0.999):
                            has_ns_show_through = True
                        with_rgb = tuple((with_rgb[i] + f_rgb[i] * (1.0 - with_a)) * anc_op for i in range(3))
                        with_a = (with_a + f_a * (1.0 - with_a)) * anc_op
                        wo_rgb = tuple((wo_rgb[i] + f_rgb[i] * (1.0 - wo_a)) * anc_op for i in range(3))
                        wo_a = (wo_a + f_a * (1.0 - wo_a)) * anc_op

                    if has_ns_show_through and wo_a < 0.999:
                        not_computed_list.append(
                            {'target': target_name, 'node_id': nid, 'name': nname, 'reason': 'non_solid_shows_through'}
                        )
                    else:
                        base = 'dump' if wo_a >= 0.999 else 'context'
                        fin_with = tuple(with_rgb[i] + ctx_rgb[i] * (1.0 - with_a) for i in range(3))
                        fin_wo = tuple(wo_rgb[i] + ctx_rgb[i] * (1.0 - wo_a) for i in range(3))

                        text_hex = rgb_to_hex(round(fin_with[0]), round(fin_with[1]), round(fin_with[2]))
                        bg_hex = rgb_to_hex(round(fin_wo[0]), round(fin_wo[1]), round(fin_wo[2]))
                        ratio = wcag_ratio(text_hex, bg_hex)
                        ratio_str = f'{ratio:.2f}'

                        is_stars = is_star_text(chars)
                        threshold = 3.0 if (is_large_text(styles) or is_stars) else 4.5

                        status = 'EXEMPT' if curr_dis else ('PASS' if ratio >= threshold else 'FAIL')
                        pairs.append(
                            {
                                'target': target_name,
                                'node_id': nid,
                                'name': nname,
                                'characters': chars[:40].replace('\n', ' '),
                                'text_hex': text_hex,
                                'bg_hex': bg_hex,
                                'ratio': ratio_str,
                                'threshold': threshold,
                                'base': base,
                                'exempt': curr_dis,
                                'status': status,
                            }
                        )

        for ch in node.get('children', []):
            walk(ch, ancestors + [node], curr_hidden, curr_dis)

    walk(root, [], False, False)
    return pairs, not_computed_list, hidden_count[0]


def hidden_text_rows(target_name, dump):
    """The text nodes of the hidden content of a dump: each text in a hidden subtree."""
    hidden = dump.hidden()
    if hidden is None:
        return None
    rows = []
    for top, _ancestors in hidden.subtrees:
        stack = [top]
        while stack:
            node = stack.pop()
            if node.get('type') == 'TEXT':
                rows.append(
                    {
                        'target': target_name,
                        'node_id': node.get('id', ''),
                        'name': node.get('name', ''),
                        'characters': node.get('characters', '')[:40].replace('\n', ' '),
                        'reason': 'hidden_node' if node is top else 'under_hidden_node',
                    }
                )
            stack.extend(reversed(node.get('children', [])))
    return rows


def summarize(target_name, pairs, not_computed, hidden):
    """The summary of the earlier script: computed, passing, and failing pairs by base."""
    active_dump = [p for p in pairs if p['base'] == 'dump' and p['status'] != 'EXEMPT']
    active_context = [p for p in pairs if p['base'] == 'context' and p['status'] != 'EXEMPT']
    return {
        'target': target_name,
        'active_dump': {
            'computed': len(active_dump),
            'passing': sum(1 for p in active_dump if p['status'] == 'PASS'),
            'failing': sum(1 for p in active_dump if p['status'] == 'FAIL'),
        },
        'active_context': {
            'computed': len(active_context),
            'passing': sum(1 for p in active_context if p['status'] == 'PASS'),
            'failing': sum(1 for p in active_context if p['status'] == 'FAIL'),
            'failing_ids': [p['node_id'] for p in active_context if p['status'] == 'FAIL'],
        },
        'exempt': sum(1 for p in pairs if p['status'] == 'EXEMPT'),
        'not_computed': len(not_computed),
        'hidden': hidden,
    }


def _first_pair(pairs):
    if not pairs:
        return {'count': 0, 'text': None, 'bg': None, 'ratio': None}
    return {'count': len(pairs), 'text': pairs[0]['text_hex'], 'bg': pairs[0]['bg_hex'], 'ratio': pairs[0]['ratio']}


def scope_figures(roots, pairs, child_name_contains):
    """The pairs of the text nodes that are direct children of a child of a root whose name holds the text."""
    ids = set()
    for root in roots:
        for child in root.get('children', []):
            if child_name_contains in child.get('name', ''):
                for gc in child.get('children', []):
                    ids.add(gc['id'])
    scoped = [p for p in pairs if p['node_id'] in ids]
    return {
        'dump': _first_pair([p for p in scoped if p['base'] == 'dump' and p['status'] != 'EXEMPT']),
        'context': _first_pair([p for p in scoped if p['base'] == 'context' and p['status'] != 'EXEMPT']),
        'exempt': sum(1 for p in scoped if p['status'] == 'EXEMPT'),
    }


def figures(dumps, vars_data, config, context_base=None, scope=None):
    """The contrast figures over one or more roots with one set of variables, for the self-check."""
    resolver = VarResolver(vars_data)
    base = context_base or config.require('context_base', 'contrast.py')
    context_bg_hex = resolve_context_base(resolver, base)
    all_pairs, all_not_computed, total_hidden = [], [], 0
    hidden_rows = []
    any_hidden = False
    for dump in dumps:
        target = dump.name or dump.path.stem
        ps, nc, hid = audit_tree(target, dump.visible(), resolver, context_bg_hex, config.disabled_variant)
        all_pairs += ps
        all_not_computed += nc
        total_hidden += hid
        rows = hidden_text_rows(target, dump)
        if rows is not None:
            any_hidden = True
            hidden_rows += rows
    result = summarize(None, all_pairs, all_not_computed, total_hidden)
    del result['target']
    result['labels'] = len(all_pairs) + total_hidden
    result['pairs'] = {}
    for p in all_pairs:
        result['pairs'].setdefault(
            p['node_id'],
            {
                'text': p['text_hex'],
                'bg': p['bg_hex'],
                'ratio': p['ratio'],
                'base': p['base'],
                'threshold': p['threshold'],
                'status': p['status'],
            },
        )
    if scope is not None:
        result['scope'] = scope_figures([dump.visible() for dump in dumps], all_pairs, scope)
    result['hidden_content'] = _hidden_figures(dumps, hidden_rows) if any_hidden else None
    return result


def _hidden_figures(dumps, hidden_rows):
    nodes = paints = 0
    for dump in dumps:
        hidden = dump.hidden()
        if hidden is not None:
            nodes += hidden.node_count
            paints += len(hidden.paints)
    return {'nodes': nodes, 'text_nodes': len(hidden_rows), 'paints': paints}


# ── Table emission ───────────────────────────────────────────────────


def emit_table(rows, resolver):
    table_data = []
    for r in rows:
        pairing = r['pairing']
        category = r['category']
        thresh_str = r.get('threshold', '').strip()
        threshold = float(thresh_str) if thresh_str else None
        token1 = r['token1']
        token2 = r['token2']

        c1 = resolver.get_color(token1)
        c2 = resolver.get_color(token2)
        if not c1 or not c2:
            raise cli.InputError(f'cannot resolve the pairing {pairing}: {token1}={c1}, {token2}={c2}')

        h1 = c1[0].upper()
        h2 = c2[0].upper()
        ratio = wcag_ratio(h1, h2)

        if threshold is not None:
            status = 'PASS' if ratio >= threshold else 'FAIL'
            ratio_str = f'{ratio:.2f}:1 (≥{threshold:.1f}:1)'
        else:
            status = 'EXEMPT'
            ratio_str = f'{ratio:.2f}:1'

        table_data.append(
            {
                'pairing': pairing,
                'category': category,
                'hex_values': f'{h1} / {h2}',
                'ratio_str': ratio_str,
                'status': status,
            }
        )

    headers = ['Token Pairing', 'Category', 'Hex Values', 'Contrast Ratio', 'Status']
    col_w = {
        'pairing': max(len(headers[0]), *(len(r['pairing']) for r in table_data)),
        'category': max(len(headers[1]), *(len(r['category']) for r in table_data)),
        'hex': max(len(headers[2]), *(len(r['hex_values']) for r in table_data)),
        'ratio': max(len(headers[3]), *(len(r['ratio_str']) for r in table_data)),
        'status': max(len(headers[4]), *(len(r['status']) for r in table_data)),
    }

    def border():
        return (
            f"+{'-' * (col_w['pairing'] + 2)}+{'-' * (col_w['category'] + 2)}+{'-' * (col_w['hex'] + 2)}"
            f"+{'-' * (col_w['ratio'] + 2)}+{'-' * (col_w['status'] + 2)}+"
        )

    def row(p, c, h, r, s):
        return (
            f"| {p.ljust(col_w['pairing'])} | {c.ljust(col_w['category'])} | {h.ljust(col_w['hex'])} "
            f"| {r.ljust(col_w['ratio'])} | {s.ljust(col_w['status'])} |"
        )

    lines = [border(), row(*headers), border()]
    for r in table_data:
        lines.append(row(r['pairing'], r['category'], r['hex_values'], r['ratio_str'], r['status']))
    lines.append(border())
    return '\n'.join(lines)


# ── Subcommands ──────────────────────────────────────────────────────


def cmd_audit(args):
    outputs = OutputDir(args.outputs, args.fixtures)
    dump = load_dump(args.dump_path, args.root, args.format)
    config = load_config(args.config)
    resolver = VarResolver(load_variables(args.vars))
    context_bg_hex = resolve_context_base(resolver, args.context_base or config.require('context_base', 'contrast.py'))

    label = args.label or dump.path.stem
    target_name = dump.root.get('name', label)

    pairs, not_computed, hidden = audit_tree(
        target_name, dump.visible(), resolver, context_bg_hex, config.disabled_variant
    )
    outputs.write_csv(f'{label}.pairs.csv', PAIR_FIELDS, pairs)
    outputs.write_csv(f'{label}.not_computed.csv', NOT_COMPUTED_FIELDS, not_computed)

    summary = summarize(target_name, pairs, not_computed, hidden)
    summary['source'] = dump.source()
    hidden_rows = hidden_text_rows(target_name, dump)
    summary['hidden_content'] = None if hidden_rows is None else _hidden_figures([dump], hidden_rows)
    if hidden_rows is not None:
        outputs.write_csv(f'{label}.hidden.csv', HIDDEN_FIELDS, hidden_rows)
    outputs.write_json(f'{label}.summary.json', summary)

    print(f'Contrast audit: {label}')
    print(f'  Active dump: {summary["active_dump"]["computed"]} computed, {summary["active_dump"]["failing"]} failing')
    print(
        f'  Active context: {summary["active_context"]["computed"]} computed, '
        f'{summary["active_context"]["failing"]} failing'
    )
    print(f'  Exempt: {summary["exempt"]}, Not computed: {summary["not_computed"]}, Hidden: {hidden}')
    if summary['hidden_content'] is not None:
        hc = summary['hidden_content']
        print(
            f'  Hidden content, not scored: {hc["text_nodes"]} text nodes in {hc["nodes"]} hidden nodes, '
            f'{hc["paints"]} hidden paints'
        )
    elif dump.format == FORMAT_DUMP_NODES:
        print('  Hidden content: not dumped (includeHidden was false); this dump is not audit evidence.')
    return cli.EXIT_OK


def cmd_table(args):
    outputs = OutputDir(args.outputs, args.fixtures)
    resolver = VarResolver(load_variables(args.vars))
    try:
        with open(args.pairs_csv, 'r', encoding='utf-8') as f:
            rows = list(csv.DictReader(f))
    except FileNotFoundError:
        raise cli.InputError(f'{args.pairs_csv}: the pairing CSV is missing.') from None
    if not rows:
        raise cli.InputError(f'{args.pairs_csv}: the pairing CSV holds no pairing.')
    table_text = emit_table(rows, resolver)
    print(table_text)
    outputs.write_text(args.out_name, table_text + '\n')
    return cli.EXIT_OK


def main():
    parser = argparse.ArgumentParser(description='WCAG 2.2 contrast auditor')
    sub = parser.add_subparsers(dest='command', required=True)

    p_audit = sub.add_parser('audit', help='Score each text of one root of a dump')
    p_audit.add_argument('dump_path', help='A dump folder, a file in one, or a baseline file')
    cli.add_dump_options(p_audit)
    p_audit.add_argument('--vars', required=True, help='A get_variable_defs payload, or a dump folder with variables.json')
    p_audit.add_argument('--config', required=True, help='The configuration with the context base')
    p_audit.add_argument('--context-base', default=None, help='Override the context base of the configuration')
    p_audit.add_argument('--label', default=None, help='The name prefix of the output files')
    cli.add_outputs_option(p_audit)

    p_table = sub.add_parser('table', help='Write the contrast table of the colour foundations')
    p_table.add_argument('pairs_csv', help='A CSV with the columns pairing, category, threshold, token1, token2')
    p_table.add_argument('--vars', required=True, help='A get_variable_defs payload')
    p_table.add_argument('--out-name', default='contrast_table.txt', help='The output file name')
    cli.add_outputs_option(p_table)

    args = parser.parse_args()
    if args.command == 'audit':
        return cmd_audit(args)
    return cmd_table(args)


if __name__ == '__main__':
    cli.run(main)
