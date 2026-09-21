import { loadFontsForTextNode } from "../shared";
import {
  describeValue,
  describeWriteError,
  messageOf,
  readBatchArray,
  readRequiredString,
  runBatchWrites,
  validationError,
} from "./batch";
import { getVariableById } from "./variables";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Text style tools.
 *
 * Add a tool by adding one entry here. Set `edit` to true when the handler
 * writes to the file.
 */

/** The fields of a text style a variable drives, and the type each one takes. */
const BINDABLE_STYLE_FIELDS: Record<VariableBindableTextField, "FLOAT" | "STRING"> = {
  fontFamily: "STRING",
  fontStyle: "STRING",
  fontSize: "FLOAT",
  fontWeight: "FLOAT",
  letterSpacing: "FLOAT",
  lineHeight: "FLOAT",
  paragraphSpacing: "FLOAT",
  paragraphIndent: "FLOAT",
};

const BINDABLE_STYLE_FIELD_NAMES = Object.keys(BINDABLE_STYLE_FIELDS);

const TEXT_CASES: readonly TextCase[] = [
  "ORIGINAL",
  "UPPER",
  "LOWER",
  "TITLE",
  "SMALL_CAPS",
  "SMALL_CAPS_FORCED",
];

const TEXT_DECORATIONS: readonly TextDecoration[] = ["NONE", "UNDERLINE", "STRIKETHROUGH"];

const LEADING_TRIMS: readonly LeadingTrim[] = ["NONE", "CAP_HEIGHT"];

/**
 * Builds the single error a failed validation pass on a one-item tool returns.
 *
 * The batch tools report `items[<index>]`; these tools have no items, so each
 * line names the field to correct instead.
 * @param tool - The tool name.
 * @param problems - One line per bad field.
 * @returns The error to throw.
 */
const fieldError = (tool: string, problems: readonly string[]): Error =>
  new Error(
    `${tool} wrote nothing. Correct these fields and call it again:\n${problems.join("\n")}`
  );

/**
 * Runs one field parser, keeping its complaint instead of throwing, so a call
 * reports every bad field at once rather than one per round trip.
 * @param problems - Collects the complaint when the parser refuses the value.
 * @param parse - Reads one field, throwing when the value is wrong.
 * @returns The parsed value, or undefined when the parser refused it.
 */
const parseField = <T>(problems: string[], parse: () => T): T | undefined => {
  try {
    return parse();
  } catch (err) {
    problems.push(messageOf(err));
    return undefined;
  }
};

/**
 * Names a value for an error message, preferring how the caller wrote it.
 * @param raw - The value.
 * @returns The value as JSON, or a phrase such as "a string".
 */
const showValue = (raw: unknown): string => {
  if (raw === undefined) return "nothing";
  const json = JSON.stringify(raw);
  return json === undefined ? describeValue(raw) : json;
};

/**
 * Reads a field that must be one of a fixed set of names.
 * @param field - The field name, for the error message.
 * @param raw - The value.
 * @param allowed - The names the field accepts.
 * @returns The value.
 */
const parseEnum = <T extends string>(field: string, raw: unknown, allowed: readonly T[]): T => {
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(`${field} must be one of ${allowed.join(", ")}, received ${showValue(raw)}.`);
};

/**
 * Reads a field that must be a finite number.
 * @param field - The field name, for the error message.
 * @param raw - The value.
 * @param min - The smallest value the field accepts, when it has one.
 * @returns The value.
 */
const parseNumber = (field: string, raw: unknown, min?: number): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${field} must be a number, received ${describeValue(raw)}.`);
  }
  if (min !== undefined && raw < min) {
    throw new Error(`${field} must be ${min} or more, received ${raw}.`);
  }
  return raw;
};

const LINE_HEIGHT_FORM =
  'Use { "unit": "AUTO" } for the line height of the font itself, or { "unit": "PIXELS" | "PERCENT", "value": <number> }.';

/**
 * Reads the `lineHeight` field.
 * @param raw - The value.
 * @returns The line height.
 */
const parseLineHeight = (raw: unknown): LineHeight => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `lineHeight must be an object, received ${describeValue(raw)}. ${LINE_HEIGHT_FORM}`
    );
  }
  const item = raw as Record<string, unknown>;
  if (item.unit === "AUTO") return { unit: "AUTO" };
  if (item.unit !== "PIXELS" && item.unit !== "PERCENT") {
    throw new Error(
      `lineHeight unit must be AUTO, PIXELS, or PERCENT, received ${showValue(item.unit)}. ${LINE_HEIGHT_FORM}`
    );
  }
  return { unit: item.unit, value: parseNumber("lineHeight value", item.value, 0) };
};

const LETTER_SPACING_FORM = 'Use { "unit": "PIXELS" | "PERCENT", "value": <number> }.';

/**
 * Reads the `letterSpacing` field.
 * @param raw - The value.
 * @returns The letter spacing.
 */
const parseLetterSpacing = (raw: unknown): LetterSpacing => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `letterSpacing must be an object, received ${describeValue(raw)}. ${LETTER_SPACING_FORM}`
    );
  }
  const item = raw as Record<string, unknown>;
  if (item.unit !== "PIXELS" && item.unit !== "PERCENT") {
    throw new Error(
      `letterSpacing unit must be PIXELS or PERCENT, received ${showValue(item.unit)}. ${LETTER_SPACING_FORM}`
    );
  }
  return { unit: item.unit, value: parseNumber("letterSpacing value", item.value) };
};

/**
 * Tests whether a name is a text style field that takes a variable.
 * @param value - The candidate field name.
 * @returns True when a variable can drive the field.
 */
const isBindableStyleField = (value: string): value is VariableBindableTextField =>
  Object.prototype.hasOwnProperty.call(BINDABLE_STYLE_FIELDS, value);

/** One field of a style and the variable to drive it, or null to unbind it. */
type StyleBinding = { field: VariableBindableTextField; variable: Variable | null };

/**
 * Reads the `boundVariables` field: a style field to a variable ID, or to null
 * to remove the binding and leave the field at its last value.
 * @param raw - The value.
 * @param problems - Collects one line per binding that cannot be written.
 * @returns The bindings that passed.
 */
const parseStyleBindings = async (raw: unknown, problems: string[]): Promise<StyleBinding[]> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(
      `boundVariables must be an object mapping a style field to a variable ID or to null, received ${describeValue(raw)}.`
    );
    return [];
  }

  const bindings: StyleBinding[] = [];
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBindableStyleField(field)) {
      problems.push(
        `boundVariables."${field}" is not a text style field that takes a variable. Use one of: ${BINDABLE_STYLE_FIELD_NAMES.join(", ")}.`
      );
      continue;
    }
    if (value === null) {
      bindings.push({ field, variable: null });
      continue;
    }
    if (typeof value !== "string") {
      problems.push(
        `boundVariables."${field}" must be a variable ID such as "VariableID:1:2", or null to remove the binding, received ${describeValue(value)}.`
      );
      continue;
    }
    const variable = await getVariableById(value);
    if (!variable) {
      problems.push(
        `boundVariables."${field}": variable not found: ${value}. Call get_variable_defs to list the variable IDs of this file.`
      );
      continue;
    }
    const wanted = BINDABLE_STYLE_FIELDS[field];
    if (variable.resolvedType !== wanted) {
      problems.push(
        `boundVariables."${field}": "${variable.name}" (${variable.id}) is a ${variable.resolvedType} variable, but "${field}" takes a ${wanted} variable. Bind a ${wanted} variable, or choose a field that takes ${variable.resolvedType}.`
      );
      continue;
    }
    bindings.push({ field, variable });
  }
  return bindings;
};

/** Every style field a create or an update call can carry. */
type StyleFieldPlan = {
  fontSize?: number;
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  textCase?: TextCase;
  textDecoration?: TextDecoration;
  leadingTrim?: LeadingTrim;
  description?: string;
  boundVariables?: StyleBinding[];
};

/** The style fields both create_text_style and update_text_style accept. */
const STYLE_FIELD_NAMES = [
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
  "textCase",
  "textDecoration",
  "leadingTrim",
  "description",
  "boundVariables",
] as const;

/**
 * The style fields that change how the text renders. A description does not,
 * so changing one alone needs no font loaded.
 */
const TEXT_PROPERTY_FIELDS = STYLE_FIELD_NAMES.filter((name) => name !== "description");

/**
 * Reads every style field a call carries, skipping the ones it leaves out.
 * @param params - The request params.
 * @param problems - Collects one line per field that cannot be written.
 * @returns The fields to write.
 */
const parseStyleFields = async (
  params: Record<string, unknown>,
  problems: string[]
): Promise<StyleFieldPlan> => {
  const plan: StyleFieldPlan = {};
  const has = (key: string) => params[key] !== undefined;

  if (has("fontSize")) {
    plan.fontSize = parseField(problems, () => parseNumber("fontSize", params.fontSize, 1));
  }
  if (has("lineHeight")) {
    plan.lineHeight = parseField(problems, () => parseLineHeight(params.lineHeight));
  }
  if (has("letterSpacing")) {
    plan.letterSpacing = parseField(problems, () => parseLetterSpacing(params.letterSpacing));
  }
  if (has("paragraphSpacing")) {
    plan.paragraphSpacing = parseField(problems, () =>
      parseNumber("paragraphSpacing", params.paragraphSpacing, 0)
    );
  }
  if (has("paragraphIndent")) {
    plan.paragraphIndent = parseField(problems, () =>
      parseNumber("paragraphIndent", params.paragraphIndent, 0)
    );
  }
  if (has("textCase")) {
    plan.textCase = parseField(problems, () => parseEnum("textCase", params.textCase, TEXT_CASES));
  }
  if (has("textDecoration")) {
    plan.textDecoration = parseField(problems, () =>
      parseEnum("textDecoration", params.textDecoration, TEXT_DECORATIONS)
    );
  }
  if (has("leadingTrim")) {
    plan.leadingTrim = parseField(problems, () =>
      parseEnum("leadingTrim", params.leadingTrim, LEADING_TRIMS)
    );
  }
  if (has("description")) {
    if (typeof params.description !== "string") {
      problems.push(
        `description must be a string, received ${describeValue(params.description)}. Pass the text Figma should show under the style, or leave description out.`
      );
    } else {
      plan.description = params.description;
    }
  }
  if (has("boundVariables")) {
    plan.boundVariables = await parseStyleBindings(params.boundVariables, problems);
  }
  return plan;
};

/**
 * Writes the style fields of a plan, leaving the ones it does not carry alone.
 *
 * Bindings go last: a variable and a literal value can name the same field, and
 * the binding is what the caller asked Figma to keep driving it with.
 * @param style - The style to write.
 * @param plan - The fields to write.
 */
const applyStyleFields = (style: TextStyle, plan: StyleFieldPlan): void => {
  if (plan.fontSize !== undefined) style.fontSize = plan.fontSize;
  if (plan.lineHeight !== undefined) style.lineHeight = plan.lineHeight;
  if (plan.letterSpacing !== undefined) style.letterSpacing = plan.letterSpacing;
  if (plan.paragraphSpacing !== undefined) style.paragraphSpacing = plan.paragraphSpacing;
  if (plan.paragraphIndent !== undefined) style.paragraphIndent = plan.paragraphIndent;
  if (plan.textCase !== undefined) style.textCase = plan.textCase;
  if (plan.textDecoration !== undefined) style.textDecoration = plan.textDecoration;
  if (plan.leadingTrim !== undefined) style.leadingTrim = plan.leadingTrim;
  if (plan.description !== undefined) style.description = plan.description;
  for (const binding of plan.boundVariables ?? []) {
    style.setBoundVariable(binding.field, binding.variable);
  }
};

/**
 * Groups every font Figma can use by family, in the order Figma lists them.
 * @returns Family name to its styles.
 */
const listFontFamilies = async (): Promise<Map<string, string[]>> => {
  const families = new Map<string, string[]>();
  for (const font of await figma.listAvailableFontsAsync()) {
    const styles = families.get(font.fontName.family);
    if (styles) {
      if (!styles.includes(font.fontName.style)) styles.push(font.fontName.style);
    } else {
      families.set(font.fontName.family, [font.fontName.style]);
    }
  }
  return families;
};

/**
 * Orders two names.
 *
 * A plain comparison rather than `localeCompare`: the plugin sandbox is not a
 * browser, so its Intl support is not something to depend on, and a font list
 * that reorders itself with the host locale is harder to test against.
 * @param a - One name.
 * @param b - The other name.
 * @returns Negative when a sorts first, positive when b does, 0 when equal.
 */
const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Counts the characters two names open with.
 * @param a - One name.
 * @param b - The other name.
 * @returns How many leading characters they share.
 */
const sharedPrefixLength = (a: string, b: string): number => {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared++;
  return shared;
};

/**
 * Names the families closest to one Figma does not have, so a misspelling
 * comes back with the spellings to try.
 * @param wanted - The family the caller asked for.
 * @param families - Every family Figma can use.
 * @returns Up to five family names, closest first.
 */
const similarFamilies = (wanted: string, families: Iterable<string>): string[] => {
  const needle = wanted.trim().toLowerCase();
  const scored: { name: string; score: number }[] = [];

  for (const name of families) {
    const candidate = name.toLowerCase();
    let score: number;
    if (candidate.startsWith(needle) || needle.startsWith(candidate)) {
      score = 0;
    } else if (candidate.includes(needle) || needle.includes(candidate)) {
      score = 1;
    } else {
      const shared = sharedPrefixLength(candidate, needle);
      if (shared === 0) continue;
      score = 2 + (needle.length - shared);
    }
    scored.push({ name, score });
  }

  scored.sort((a, b) => a.score - b.score || compareNames(a.name, b.name));
  return scored.slice(0, 5).map((entry) => entry.name);
};

/**
 * Resolves a family and a style to a font Figma has, and loads it.
 *
 * A text property of a style cannot be written until its font is loaded, so
 * this runs during validation: a font the file cannot use is reported before
 * anything is written.
 * @param family - The font family.
 * @param style - The font style within that family.
 * @param problems - Collects the complaint when the font is unavailable.
 * @returns The loaded font, or undefined when there is none to load.
 */
const resolveFont = async (
  family: string,
  style: string,
  problems: string[]
): Promise<FontName | undefined> => {
  const families = await listFontFamilies();
  const styles = families.get(family);

  if (!styles) {
    const near = similarFamilies(family, families.keys());
    const suggestion =
      near.length > 0 ? ` Did you mean ${near.map((name) => `"${name}"`).join(", ")}?` : "";
    problems.push(
      `fontFamily "${family}" is not available in Figma.${suggestion} Call list_fonts to see the families this file can use.`
    );
    return undefined;
  }
  if (!styles.includes(style)) {
    problems.push(
      `fontStyle "${style}" is not available for "${family}". That family has: ${styles.join(", ")}.`
    );
    return undefined;
  }

  const font: FontName = { family, style };
  try {
    await figma.loadFontAsync(font);
  } catch (err) {
    problems.push(
      `the font "${family} ${style}" could not be loaded: ${messageOf(err)}. Call list_fonts to see the families this file can use.`
    );
    return undefined;
  }
  return font;
};

/**
 * Looks a text style up by ID.
 *
 * `getStyleByIdAsync` throws on a malformed ID and resolves to null on an
 * unknown one, and the ID of another kind of style resolves to that style, so
 * each case comes back as the sentence that names it.
 * @param styleId - The style ID.
 * @returns The style, or the sentence explaining why there is none.
 */
const findTextStyle = async (styleId: string): Promise<TextStyle | string> => {
  let style: BaseStyle | null = null;
  try {
    style = await figma.getStyleByIdAsync(styleId);
  } catch {
    style = null;
  }
  if (!style) {
    return `text style not found: ${styleId}. Call get_styles to list the text style IDs of this file.`;
  }
  if (style.type !== "TEXT") {
    return `${styleId} is a ${style.type} style, not a text style. Call get_styles and use an ID from its "text" list.`;
  }
  return style as TextStyle;
};

/**
 * Looks a text style up by ID, throwing the reason when there is none.
 * @param styleId - The style ID.
 * @param tool - The tool name, for the error message.
 * @returns The style.
 */
const getTextStyleById = async (styleId: string, tool: string): Promise<TextStyle> => {
  const found = await findTextStyle(styleId);
  if (typeof found === "string") throw new Error(`${tool} wrote nothing: ${found}`);
  return found;
};

/**
 * Loads the font a style already carries.
 *
 * Every text property of a style is written through its font, so the current
 * one has to be loaded even when the call does not change it.
 * @param style - The style.
 * @param problems - Collects the complaint when the font cannot be loaded.
 */
const loadStyleFont = async (style: TextStyle, problems: string[]): Promise<void> => {
  try {
    await figma.loadFontAsync(style.fontName);
  } catch (err) {
    problems.push(
      `the font "${style.fontName.family} ${style.fontName.style}" this style already uses could not be loaded: ${messageOf(err)}. Give the style a font this file can use with fontFamily and fontStyle.`
    );
  }
};

/**
 * Lists the fonts Figma can use, grouped by family.
 * @param req - The extension request.
 * @returns The matching families with their styles, and whether the limit cut
 * the list short.
 */
const listFonts = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "list_fonts";
  const { query, limit: rawLimit } = req.params;

  if (query !== undefined && typeof query !== "string") {
    throw new Error(
      `${tool} requires query as a string, received ${describeValue(query)}. Pass part of a family name to filter, or leave query out to list every family.`
    );
  }
  let limit = 50;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1) {
      throw new Error(
        `${tool} requires limit as a whole number of 1 or more, received ${describeValue(rawLimit)}. Leave limit out for the default of 50.`
      );
    }
    limit = Math.min(rawLimit, 200);
  }

  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  const matched = [...(await listFontFamilies()).entries()]
    .filter(([family]) => needle === "" || family.toLowerCase().includes(needle))
    .sort(([a], [b]) => compareNames(a, b));

  return {
    fonts: matched.slice(0, limit).map(([family, styles]) => ({ family, styles })),
    truncated: matched.length > limit,
  };
};

/**
 * Removes a style, ignoring a failure to do so.
 *
 * Used to undo a half-written style: the write that failed is what the caller
 * needs to hear about, not a second failure while cleaning up after it.
 * @param style - The style to remove.
 */
const removeQuietly = (style: TextStyle): void => {
  try {
    style.remove();
  } catch {
    // Already gone, or Figma refuses; the original failure is what matters.
  }
};

/**
 * Creates a local text style.
 *
 * A free (Starter) plan carries local styles; only publishing them to a team
 * library needs a paid one, and this tool does not publish.
 * @param req - The extension request.
 * @returns The new style's ID and name.
 */
const createTextStyle = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "create_text_style";
  const params = req.params;
  const name = readRequiredString(params, "name", tool);
  const fontFamily = readRequiredString(params, "fontFamily", tool);
  const fontStyle = readRequiredString(params, "fontStyle", tool);

  const problems: string[] = [];

  if ((await figma.getLocalTextStylesAsync()).some((style) => style.name === name)) {
    problems.push(
      `a local text style named "${name}" already exists. Pick another name, or change that style with update_text_style.`
    );
  }
  if (params.fontSize === undefined) {
    problems.push("fontSize is required. Give the size in pixels, for example 16.");
  }

  const font = await resolveFont(fontFamily, fontStyle, problems);
  const fields = await parseStyleFields(params, problems);

  if (problems.length > 0) throw fieldError(tool, problems);

  let style: TextStyle;
  try {
    style = figma.createTextStyle();
  } catch (err) {
    throw describeWriteError(`${tool} could not create "${name}"`, err);
  }

  let failure: unknown;
  try {
    // `font` is set here: resolveFont returns undefined only after pushing a
    // problem, and a problem would have thrown above.
    style.name = name;
    style.fontName = font as FontName;
    applyStyleFields(style, fields);
  } catch (err) {
    failure = err;
  }

  if (failure !== undefined) {
    // Take the half-written style back out, so a failure leaves the file as it
    // was rather than leaving behind a style the caller cannot use.
    removeQuietly(style);
    throw describeWriteError(`${tool} could not write "${name}"`, failure);
  }

  return { id: style.id, name: style.name };
};

/**
 * Changes a local text style. Every field the call leaves out stays as it is,
 * and the text nodes linked to the style pick the change up.
 * @param req - The extension request.
 * @returns The style's ID and name.
 */
const updateTextStyle = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "update_text_style";
  const params = req.params;
  const styleId = readRequiredString(params, "styleId", tool);
  const style = await getTextStyleById(styleId, tool);

  const changed = ["name", "fontFamily", "fontStyle", ...STYLE_FIELD_NAMES].filter(
    (key) => params[key] !== undefined
  );
  if (changed.length === 0) {
    throw new Error(
      `${tool} needs at least one field to change. Give name, fontFamily, fontStyle, or one of: ${STYLE_FIELD_NAMES.join(", ")}.`
    );
  }

  const problems: string[] = [];

  let name: string | undefined;
  if (params.name !== undefined) {
    if (typeof params.name !== "string" || params.name.trim() === "") {
      problems.push(
        `name must be a non-empty string, received ${describeValue(params.name)}. A "/" groups the style, as in "Heading/H1".`
      );
    } else {
      name = params.name;
      const clash = (await figma.getLocalTextStylesAsync()).some(
        (other) => other.id !== style.id && other.name === name
      );
      if (clash) {
        problems.push(`a local text style named "${name}" already exists. Pick another name.`);
      }
    }
  }

  // The style's current font has to be loaded before any text property of it
  // can be written, and a new font before it can replace the current one. A
  // call that only renames the style or rewrites its description touches no
  // text property, so it goes through even when the font is unavailable.
  const changesText =
    params.fontFamily !== undefined ||
    params.fontStyle !== undefined ||
    TEXT_PROPERTY_FIELDS.some((field) => params[field] !== undefined);
  if (changesText) await loadStyleFont(style, problems);

  let font: FontName | undefined;
  if (params.fontFamily !== undefined || params.fontStyle !== undefined) {
    const family = params.fontFamily ?? style.fontName.family;
    const weight = params.fontStyle ?? style.fontName.style;
    if (typeof family !== "string" || family.trim() === "") {
      problems.push(
        `fontFamily must be a non-empty string, received ${describeValue(family)}. Call list_fonts to see the families this file can use.`
      );
    } else if (typeof weight !== "string" || weight.trim() === "") {
      problems.push(
        `fontStyle must be a non-empty string, received ${describeValue(weight)}. Call list_fonts to see the styles the family has, such as "Regular" or "Bold".`
      );
    } else {
      font = await resolveFont(family, weight, problems);
    }
  }

  const fields = await parseStyleFields(params, problems);

  if (problems.length > 0) throw fieldError(tool, problems);

  try {
    if (name !== undefined) style.name = name;
    if (font !== undefined) style.fontName = font;
    applyStyleFields(style, fields);
  } catch (err) {
    throw describeWriteError(`${tool} could not write ${styleId}`, err);
  }

  return { id: style.id, name: style.name };
};

/**
 * Removes a local text style.
 *
 * The text nodes that used it keep the look they had: Figma leaves the values
 * on them and drops the link.
 * @param req - The extension request.
 * @returns The removed style's ID.
 */
const deleteTextStyle = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "delete_text_style";
  if (req.params.confirm !== true) {
    throw new Error(
      `${tool} requires confirm: true. It removes the style; the text nodes that used it keep the look they had and lose the link to it.`
    );
  }
  const styleId = readRequiredString(req.params, "styleId", tool);
  const style = await getTextStyleById(styleId, tool);

  // Read off the style before the removal: the object throws on every property
  // access once it is gone.
  const id = style.id;

  try {
    style.remove();
  } catch (err) {
    throw describeWriteError(`${tool} could not remove ${styleId}`, err);
  }

  return { id };
};

/** A stretch of one text node, as characters counted from zero. */
type TextRange = { start: number; end: number };

/** One validated `apply_text_style` item, ready to write. */
type ApplyPlan = { node: TextNode; styleId: string; range?: TextRange };

const RANGE_FORM = 'Use { "start": <number>, "end": <number> }, counting characters from 0.';

/**
 * Reads the `range` field.
 * @param raw - The value.
 * @returns The range.
 */
const parseRange = (raw: unknown): TextRange => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`range must be an object, received ${describeValue(raw)}. ${RANGE_FORM}`);
  }
  const item = raw as Record<string, unknown>;
  const read = (key: "start" | "end"): number => {
    const value = item[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `range.${key} must be a whole number of 0 or more, received ${describeValue(value)}. ${RANGE_FORM}`
      );
    }
    return value;
  };
  const start = read("start");
  const end = read("end");
  if (start >= end) {
    throw new Error(
      `range.start must come before range.end, received start ${start} and end ${end}. A range covers at least one character.`
    );
  }
  return { start, end };
};

/**
 * Applies a text style to text nodes, or removes the link to one.
 *
 * A style applied to a whole node replaces every text property it carries; a
 * `range` applies it to those characters only, which leaves the node reporting
 * `textStyleId: "mixed"`.
 *
 * The fonts of each node and of the style are loaded during validation, which
 * touches nothing in the file, so a font the file cannot use is reported
 * before any write.
 * @param req - The extension request.
 * @returns One result entry per item.
 */
const applyTextStyle = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "apply_text_style";
  // The node IDs travel in the request's own `nodeIds` field, as they do for
  // the core tools that take a list of nodes, not among the params.
  const rawNodeIds = readBatchArray({ nodeIds: req.nodeIds }, "nodeIds", tool);
  const problems: string[] = [];

  // "" is what Figma takes to mean "no style", so a null styleId becomes one.
  let styleId = "";
  let style: TextStyle | null = null;
  const rawStyleId = req.params.styleId;
  if (rawStyleId === null) {
    styleId = "";
  } else if (typeof rawStyleId !== "string" || rawStyleId.trim() === "") {
    problems.push(
      `styleId is required. Give a text style ID such as "S:abc123,", or null to remove the style link. Call get_styles to list them.`
    );
  } else {
    const found = await findTextStyle(rawStyleId);
    if (typeof found === "string") {
      problems.push(found);
    } else {
      style = found;
      styleId = found.id;
    }
  }

  let range: TextRange | undefined;
  if (req.params.range !== undefined && req.params.range !== null) {
    range = parseField(problems, () => parseRange(req.params.range));
    if (range && rawNodeIds.length > 1) {
      problems.push(
        `range applies to one node at a time, but nodeIds carries ${rawNodeIds.length}. Call ${tool} once per node, or drop range to style each node whole.`
      );
      range = undefined;
    }
  }

  // The style brings its own font to every node it lands on.
  if (style) await loadStyleFont(style, problems);

  const plans: ApplyPlan[] = [];
  for (let index = 0; index < rawNodeIds.length; index++) {
    const rawNodeId = rawNodeIds[index];
    const fail = (problem: string) => problems.push(`items[${index}]: ${problem}`);

    if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
      fail(
        `each item must be a node ID such as "4029:12345", received ${describeValue(rawNodeId)}. Call get_document or get_selection to list them.`
      );
      continue;
    }

    const node = await figma.getNodeByIdAsync(rawNodeId);
    if (!node) {
      fail(
        `node not found: ${rawNodeId}. Call get_document or get_selection to list the node IDs of this page.`
      );
      continue;
    }
    if (node.type !== "TEXT") {
      fail(
        `${rawNodeId} "${node.name}" is a ${node.type} node, not a TEXT node. A text style applies to text nodes only.`
      );
      continue;
    }

    const textNode = node as TextNode;
    const itemProblems: string[] = [];

    // Every write through a text node needs the fonts it already carries.
    try {
      await loadFontsForTextNode(textNode);
    } catch (err) {
      itemProblems.push(`${messageOf(err)}. Give the text node one font before styling it.`);
    }
    if (range && range.end > textNode.characters.length) {
      itemProblems.push(
        `range.end ${range.end} is past the end of ${textNode.id} "${textNode.name}", which holds ${textNode.characters.length} character${textNode.characters.length === 1 ? "" : "s"}. Use an end of ${textNode.characters.length} or less.`
      );
    }

    if (itemProblems.length > 0) {
      itemProblems.forEach(fail);
    } else {
      plans.push({ node: textNode, styleId, range });
    }
  }

  if (problems.length > 0) throw validationError(tool, problems);

  return runBatchWrites(plans, async (plan) => {
    if (plan.range) {
      await plan.node.setRangeTextStyleIdAsync(plan.range.start, plan.range.end, plan.styleId);
    } else {
      await plan.node.setTextStyleIdAsync(plan.styleId);
    }
    return { nodeId: plan.node.id };
  });
};

export const typographyHandlers = {
  list_fonts: { edit: false, run: listFonts },
  create_text_style: { edit: true, run: createTextStyle },
  update_text_style: { edit: true, run: updateTextStyle },
  delete_text_style: { edit: true, run: deleteTextStyle },
  apply_text_style: { edit: true, run: applyTextStyle },
} satisfies Record<string, ExtensionHandler>;
