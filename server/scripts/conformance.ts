/**
 * The normalisation of the dump-conformance test (BR-7).
 *
 * The e2e script builds the conformance fixture again at each run, so each
 * node, style, variable, and component property gets a new ID. The
 * normalisation replaces each such ID with a placeholder in document order,
 * and thus two runs of the same fixture give the same value, which the golden
 * dump holds.
 *
 * The walk order is fixed: the roots in the order they are given, each tree in
 * pre-order. In a node, `id` comes first, then each other field in sorted key
 * order, then `children`. An ID gets its placeholder at its first sight in
 * that order, whether in an `id` or in a field that refers to a node.
 *
 * - A node ID becomes `N1`, `N2`, and so on. An instance-child ID such as
 *   `I12:3;45:6` maps each part: `I<map of 12:3>;<map of 45:6>`.
 * - A style ID (`S:...`) becomes `S1`, `S2`, and so on.
 * - A variable ID (`VariableID:...`) becomes `V1`, `V2`, and so on.
 * - The `#<id>` suffix of a component property name becomes `#P1`, `#P2`,
 *   and so on.
 *
 * Each other value stays as it is. The module imports nothing but the
 * canonical JSON of the evidence files, so the harness test runs it without
 * Figma.
 */

import { canonicalJson } from "../src/evidence.js";

type Json = Record<string, unknown>;

/** The fields whose value is a node ID. */
const NODE_ID_FIELDS = new Set(["mainComponentId", "componentSetId"]);

/** The fields whose value is a style ID. */
const STYLE_ID_FIELDS = new Set([
  "textStyleId",
  "fillStyleId",
  "strokeStyleId",
  "effectStyleId",
  "gridStyleId",
]);

/** A whole string that is a variable ID. Text that only starts with the prefix stays. */
const VARIABLE_ID = /^VariableID:\S+$/;
const STYLE_PREFIX = "S:";

/** A component property name with the suffix Figma appends, as `Label#12:0`. */
const PROPERTY_SUFFIX = /^(.*)#([^#]+)$/;

/** The roots of the golden dump, in walk order. */
export const GOLDEN_ROOTS = ["button-set", "screen", "target"] as const;

export type GoldenRoot = (typeof GOLDEN_ROOTS)[number];

/** One sequence of placeholders: the first ID seen gets `<prefix>1`. */
class Placeholders {
  private readonly map = new Map<string, string>();

  constructor(private readonly prefix: string) {}

  /**
   * The placeholder of an ID, made at its first sight.
   * @param id - The ID.
   * @returns For example `N3`.
   */
  of(id: string): string {
    let placeholder = this.map.get(id);
    if (placeholder === undefined) {
      placeholder = `${this.prefix}${this.map.size + 1}`;
      this.map.set(id, placeholder);
    }
    return placeholder;
  }
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normalises the dumps of one run. One instance holds the maps, so an ID that
 * two roots share gets one placeholder.
 */
export class Normaliser {
  private readonly nodes = new Placeholders("N");
  private readonly styles = new Placeholders("S");
  private readonly variables = new Placeholders("V");
  private readonly properties = new Placeholders("P");

  /**
   * The placeholder of a node ID. An instance-child ID maps part by part.
   * @param id - The node ID.
   * @returns For example `N3`, or `IN3;N5` for `I12:3;45:6`.
   */
  nodeId(id: string): string {
    if (id.startsWith("I") && id.includes(":")) {
      return `I${id
        .slice(1)
        .split(";")
        .map((part) => this.nodes.of(part))
        .join(";")}`;
    }
    return this.nodes.of(id);
  }

  /**
   * Normalises one dumped node and its subtree.
   * @param node - The node, as a dump file holds it.
   * @returns A copy with each run-specific ID replaced.
   */
  node(node: unknown): unknown {
    if (!isRecord(node)) return this.value(node, "");
    const copy: Json = {};
    if (typeof node.id === "string") copy.id = this.nodeId(node.id);
    for (const key of Object.keys(node).sort()) {
      if (key === "id" || key === "children") continue;
      copy[key] = this.field(key, node[key]);
    }
    if (Array.isArray(node.children)) {
      copy.children = node.children.map((child) => this.node(child));
    }
    return copy;
  }

  /**
   * Normalises one field of a node.
   * @param key - The field name.
   * @param value - The field value.
   * @returns The copy.
   */
  private field(key: string, value: unknown): unknown {
    if (NODE_ID_FIELDS.has(key) && typeof value === "string") return this.nodeId(value);
    if (key === "detachedInfo" && isRecord(value)) {
      const copy = this.value(value, key) as Json;
      if (typeof value.componentId === "string") copy.componentId = this.nodeId(value.componentId);
      return copy;
    }
    if (key === "flowStartingPoints" && Array.isArray(value)) {
      return value.map((point) => {
        const copy = this.value(point, "") as Json;
        if (isRecord(point) && typeof point.nodeId === "string") {
          copy.nodeId = this.nodeId(point.nodeId);
        }
        return copy;
      });
    }
    return this.value(value, key);
  }

  /**
   * Normalises any JSON value: each variable ID, each style ID under a style
   * field, each `destinationId` (in `actions`, in the older `action`, and in a
   * conditional block), and each component property name under
   * `componentProperties`.
   * @param value - The value.
   * @param key - The field that holds it, or "" for an array entry or a root.
   * @returns The copy.
   */
  private value(value: unknown, key: string): unknown {
    if (typeof value === "string") {
      if (VARIABLE_ID.test(value)) return this.variables.of(value);
      if (STYLE_ID_FIELDS.has(key) && value.startsWith(STYLE_PREFIX)) return this.styles.of(value);
      if (key === "destinationId") return this.nodeId(value);
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => this.value(entry, ""));
    if (!isRecord(value)) return value;

    const copy: Json = {};
    for (const field of Object.keys(value).sort()) {
      const name = key === "componentProperties" ? this.propertyName(field) : field;
      copy[name] = this.value(value[field], field);
    }
    return copy;
  }

  /**
   * Replaces the `#<id>` suffix of a component property name.
   * @param name - For example `Label#12:0`.
   * @returns For example `Label#P1`; a name without a suffix stays.
   */
  private propertyName(name: string): string {
    const match = PROPERTY_SUFFIX.exec(name);
    return match ? `${match[1]}#${this.properties.of(match[2])}` : name;
  }
}

/**
 * Normalises the dumps of the golden roots, in the order of `GOLDEN_ROOTS`.
 * @param dumps - Each root key to the parsed dump file of that root.
 * @returns The value the golden dump holds.
 */
export const normaliseGolden = (
  dumps: Record<GoldenRoot, unknown>
): Record<GoldenRoot, unknown> => {
  const normaliser = new Normaliser();
  const result = {} as Record<GoldenRoot, unknown>;
  for (const root of GOLDEN_ROOTS) result[root] = normaliser.node(dumps[root]);
  return result;
};

/**
 * The form the test compares: canonical JSON, which sorts the keys and holds
 * no whitespace. The layout of the golden file on disk does not count.
 * @param value - The parsed golden dump, or the normalised dumps.
 * @returns The canonical JSON text.
 */
export const comparableForm = (value: unknown): string => canonicalJson(value);

/**
 * A copy of a value with the keys of each object in sorted order.
 * @param value - The value.
 * @returns The copy.
 */
const sortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  const copy: Json = {};
  for (const key of Object.keys(value).sort()) copy[key] = sortedKeys(value[key]);
  return copy;
};

/**
 * The text of the golden file: sorted keys, indented, as Prettier formats a
 * JSON file. A readable file gives a readable diff when the golden changes.
 * @param value - The normalised dumps.
 * @param path - The path of the golden file, where Prettier looks for its configuration.
 * @returns The file text, with a final newline.
 */
export const goldenText = async (value: unknown, path: string): Promise<string> => {
  const text = `${JSON.stringify(sortedKeys(value), null, 2)}\n`;
  try {
    // Prettier is a development dependency of the repository root, which the
    // commit hook and the format check use. Without it the file is still valid.
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(path)) ?? {};
    return await prettier.format(text, { ...options, parser: "json" });
  } catch {
    return text;
  }
};
