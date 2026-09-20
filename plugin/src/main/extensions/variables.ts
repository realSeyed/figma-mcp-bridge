import { parseHexColor } from "../shared";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Variable and variable-collection tools.
 *
 * Add a tool by adding one entry here. Set `edit` to true when the handler
 * writes to the file.
 */

/**
 * Reads a required non-empty string parameter.
 * @param params - The request params.
 * @param key - The parameter name.
 * @param tool - The tool name, for the error message.
 * @returns The parameter value.
 */
const readRequiredString = (params: Record<string, unknown>, key: string, tool: string): string => {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${tool} requires ${key} as a non-empty string.`);
  }
  return value;
};

/**
 * Rewrites a failure from a Figma write so the message carries a correction,
 * and names the plan limit when Figma rejected the call because of one.
 * @param err - The error Figma threw.
 * @returns The sentence to report.
 */
const describeWriteFailure = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(limit|plan|upgrade|professional|organization|enterprise|subscri\w*)\b/i.test(message)) {
    return `${message}. This is a Figma plan limit. A free (Starter) account keeps one mode per collection and cannot publish a library or use extended collections; a paid plan lifts the limit.`;
  }
  return `${message}.`;
};

/**
 * Wraps a failed Figma write in an error that names what the handler was doing.
 * @param action - What the handler was doing, phrased for a message.
 * @param err - The error Figma threw.
 * @returns The error to throw on.
 */
const describeWriteError = (action: string, err: unknown): Error =>
  new Error(`${action}: ${describeWriteFailure(err)}`);

/**
 * Looks a variable collection up by ID.
 *
 * `getVariableCollectionByIdAsync` throws on a malformed ID and resolves to
 * null on an unknown one, so both paths end in the same message.
 * @param collectionId - The collection ID.
 * @returns The collection.
 */
export const getVariableCollectionById = async (
  collectionId: string
): Promise<VariableCollection> => {
  let collection: VariableCollection | null = null;
  try {
    collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
  } catch {
    collection = null;
  }
  if (!collection) {
    throw new Error(
      `Variable collection not found: ${collectionId}. Call get_variable_defs to list the collection IDs of this file.`
    );
  }
  return collection;
};

/**
 * Creates an empty variable collection.
 *
 * Figma gives the new collection a single mode. Adding a mode needs a paid
 * plan, so the default mode is the only one these tools ever write to.
 * @param req - The extension request.
 * @returns The new collection's ID, name, and default mode ID.
 */
const createVariableCollection = async (req: ExtensionRequest): Promise<unknown> => {
  const name = readRequiredString(req.params, "name", "create_variable_collection");

  let collection: VariableCollection;
  try {
    collection = figma.variables.createVariableCollection(name);
  } catch (err) {
    throw describeWriteError(`create_variable_collection could not create "${name}"`, err);
  }

  return {
    id: collection.id,
    name: collection.name,
    defaultModeId: collection.defaultModeId,
  };
};

/**
 * Renames a variable collection. Nothing else about the collection changes.
 * @param req - The extension request.
 * @returns The collection's ID and new name.
 */
const updateVariableCollection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "update_variable_collection";
  const collectionId = readRequiredString(req.params, "collectionId", tool);
  const name = readRequiredString(req.params, "name", tool);
  const collection = await getVariableCollectionById(collectionId);

  try {
    collection.name = name;
  } catch (err) {
    throw describeWriteError(`${tool} could not rename ${collectionId} to "${name}"`, err);
  }

  return { id: collection.id, name: collection.name };
};

/**
 * Removes a variable collection and every variable inside it.
 * @param req - The extension request.
 * @returns The removed collection's ID and how many variables went with it.
 */
const deleteVariableCollection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "delete_variable_collection";
  if (req.params.confirm !== true) {
    throw new Error(
      `${tool} requires confirm: true. It removes the collection and every variable in it, and any node bound to one of those variables keeps its last resolved value.`
    );
  }
  const collectionId = readRequiredString(req.params, "collectionId", tool);
  const collection = await getVariableCollectionById(collectionId);

  // Both are read off the collection before the removal: the object throws on
  // every property access once it is gone.
  const id = collection.id;
  const removedVariableCount = collection.variableIds.length;

  try {
    collection.remove();
  } catch (err) {
    throw describeWriteError(`${tool} could not remove ${collectionId}`, err);
  }

  return { id, removedVariableCount };
};

/** The resolved types these tools write. EASING and TIMING are out of scope. */
export type SupportedVariableType = "BOOLEAN" | "COLOR" | "FLOAT" | "STRING";

const SUPPORTED_VARIABLE_TYPES: readonly SupportedVariableType[] = [
  "BOOLEAN",
  "COLOR",
  "FLOAT",
  "STRING",
];

/**
 * The scopes Figma accepts per resolved type, from the VariableScope
 * documentation. A scope decides where Figma offers the variable in the UI,
 * and Figma rejects one that does not match the type, so the map is checked
 * before anything is written.
 */
export const SCOPES_BY_VARIABLE_TYPE: Record<SupportedVariableType, readonly VariableScope[]> = {
  COLOR: [
    "ALL_SCOPES",
    "ALL_FILLS",
    "FRAME_FILL",
    "SHAPE_FILL",
    "TEXT_FILL",
    "STROKE_COLOR",
    "EFFECT_COLOR",
  ],
  FLOAT: [
    "ALL_SCOPES",
    "TEXT_CONTENT",
    "CORNER_RADIUS",
    "WIDTH_HEIGHT",
    "GAP",
    "OPACITY",
    "STROKE_FLOAT",
    "EFFECT_FLOAT",
    "FONT_WEIGHT",
    "FONT_SIZE",
    "LINE_HEIGHT",
    "LETTER_SPACING",
    "PARAGRAPH_SPACING",
    "PARAGRAPH_INDENT",
  ],
  STRING: ["ALL_SCOPES", "TEXT_CONTENT", "FONT_FAMILY", "FONT_STYLE"],
  BOOLEAN: ["ALL_SCOPES"],
};

/** A value ready to write, or an alias that still has to be resolved. */
export type ParsedVariableValue =
  | { kind: "value"; value: VariableValue }
  | { kind: "aliasId"; aliasId: string }
  | { kind: "aliasName"; aliasName: string };

/** One batch item, as far as the alias lookup needs to know it. */
export type VariableBatchEntry = { name: string; type: SupportedVariableType };

/**
 * Where an alias target was found. A target inside the batch has no ID yet, so
 * it travels as the index of the item that will create it.
 */
export type AliasLookup =
  | { source: "batch"; index: number; type: SupportedVariableType }
  | { source: "document"; variable: Variable };

/**
 * Names the type of a value for an error message.
 * @param raw - The value.
 * @returns A phrase such as "a string".
 */
const describeValue = (raw: unknown): string => {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "an array";
  return `a ${typeof raw}`;
};

/**
 * Reads the message of a thrown value.
 * @param err - The thrown value.
 * @returns The message.
 */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Builds the single error a failed validation pass returns.
 * @param tool - The tool name.
 * @param problems - One line per bad item.
 * @returns The error to throw.
 */
const validationError = (tool: string, problems: readonly string[]): Error =>
  new Error(
    `${tool} wrote nothing. Correct these items and call it again:\n${problems.join("\n")}`
  );

/**
 * Tests whether a type name is one this area writes.
 * @param value - The candidate type name.
 * @returns True when the type is supported.
 */
const isSupportedVariableType = (value: string): value is SupportedVariableType =>
  SUPPORTED_VARIABLE_TYPES.includes(value as SupportedVariableType);

/**
 * Looks a variable up by ID without throwing on a malformed or unknown one.
 * @param variableId - The variable ID.
 * @returns The variable, or null when there is none.
 */
export const getVariableById = async (variableId: string): Promise<Variable | null> => {
  try {
    return await figma.variables.getVariableByIdAsync(variableId);
  } catch {
    return null;
  }
};

/**
 * Parses a hex string into the RGBA that a COLOR variable stores.
 *
 * Widens the shared parser, which carries no alpha: a variable holds RGBA, so
 * #RRGGBBAA is accepted here and a shorter form resolves to an opaque color.
 * @param hex - The hex string, with or without the leading '#'.
 * @returns The color.
 */
export const parseVariableColor = (hex: string): RGBA => {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(normalized)) {
    throw new Error(
      `value "${hex}" is not a hex color. Use #RGB, #RRGGBB, or #RRGGBBAA, for example "#3366FF".`
    );
  }
  const rgb = parseHexColor(`#${normalized.length === 3 ? normalized : normalized.slice(0, 6)}`);
  const alpha = normalized.length === 8 ? parseInt(normalized.slice(6, 8), 16) / 255 : 1;
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
};

/**
 * Parses the `value` field of a batch item against the type of that item.
 * @param type - The resolved type of the item.
 * @param raw - The raw value.
 * @returns The parsed value, or the alias left to resolve.
 */
export const parseVariableValue = (
  type: SupportedVariableType,
  raw: unknown
): ParsedVariableValue => {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const { aliasId, aliasName } = raw as { aliasId?: unknown; aliasName?: unknown };
    if (aliasId !== undefined && aliasName !== undefined) {
      throw new Error("value carries both aliasId and aliasName. Give exactly one of them.");
    }
    if (typeof aliasId === "string" && aliasId !== "") return { kind: "aliasId", aliasId };
    if (typeof aliasName === "string" && aliasName !== "") return { kind: "aliasName", aliasName };
    throw new Error(
      'value must be a plain value or an alias such as { "aliasName": "color/brand" } or { "aliasId": "VariableID:1:2" }.'
    );
  }

  switch (type) {
    case "COLOR":
      if (typeof raw !== "string") {
        throw new Error(
          `value for a COLOR variable must be a hex string such as "#3366FF", received ${describeValue(raw)}.`
        );
      }
      return { kind: "value", value: parseVariableColor(raw) };
    case "FLOAT":
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(
          `value for a FLOAT variable must be a finite number such as 16, received ${describeValue(raw)}.`
        );
      }
      return { kind: "value", value: raw };
    case "STRING":
      if (typeof raw !== "string") {
        throw new Error(
          `value for a STRING variable must be a string such as "Inter", received ${describeValue(raw)}.`
        );
      }
      return { kind: "value", value: raw };
    case "BOOLEAN":
      if (typeof raw !== "boolean") {
        throw new Error(
          `value for a BOOLEAN variable must be true or false, received ${describeValue(raw)}.`
        );
      }
      return { kind: "value", value: raw };
  }
};

/**
 * Checks a scope list against a resolved type, and against the two
 * combination rules Figma enforces.
 * @param type - The resolved type of the variable.
 * @param scopes - The requested scopes.
 */
export const validateVariableScopes = (
  type: SupportedVariableType,
  scopes: readonly VariableScope[]
): void => {
  const allowed = SCOPES_BY_VARIABLE_TYPE[type];
  const rejected = scopes.filter((scope) => !allowed.includes(scope));
  if (rejected.length > 0) {
    throw new Error(
      `scopes ${rejected.join(", ")} cannot apply to a ${type} variable. Valid scopes for ${type}: ${allowed.join(", ")}.`
    );
  }
  if (scopes.includes("ALL_SCOPES") && scopes.length > 1) {
    throw new Error(
      "ALL_SCOPES must be the only entry in scopes. Drop the other scopes, or drop ALL_SCOPES."
    );
  }
  if (
    scopes.includes("ALL_FILLS") &&
    scopes.some(
      (scope) => scope === "FRAME_FILL" || scope === "SHAPE_FILL" || scope === "TEXT_FILL"
    )
  ) {
    throw new Error(
      "ALL_FILLS cannot be combined with FRAME_FILL, SHAPE_FILL, or TEXT_FILL. Keep ALL_FILLS, or list the single fill scopes."
    );
  }
};

/**
 * Resolves an `aliasName` to the variable it points at.
 *
 * One order decides: this batch, then the target collection, then the other
 * local collections. The first step with a match wins, so a token name that
 * exists in several collections resolves to the one nearest the caller. A step
 * with more than one match is ambiguous and reports the IDs to choose from.
 * @param aliasName - The name to find.
 * @param batch - Every item of the current batch, in order.
 * @param collectionVariables - Existing variables of the target collection.
 * @param otherVariables - Existing variables of every other collection.
 * @returns Where the target was found.
 */
export const findAliasByName = (
  aliasName: string,
  batch: readonly VariableBatchEntry[],
  collectionVariables: readonly Variable[],
  otherVariables: readonly Variable[]
): AliasLookup => {
  const batchMatches: number[] = [];
  batch.forEach((entry, index) => {
    if (entry.name === aliasName) batchMatches.push(index);
  });
  if (batchMatches.length > 1) {
    throw new Error(
      `aliasName "${aliasName}" matches items ${batchMatches.join(", ")} of this batch. Give every item a unique name.`
    );
  }
  if (batchMatches.length === 1) {
    const index = batchMatches[0];
    return { source: "batch", index, type: batch[index].type };
  }

  const inCollection = collectionVariables.filter((variable) => variable.name === aliasName);
  if (inCollection.length > 1) {
    throw new Error(
      `aliasName "${aliasName}" matches ${inCollection.length} variables in the target collection (${inCollection.map((variable) => variable.id).join(", ")}). Use aliasId to pick one.`
    );
  }
  if (inCollection.length === 1) return { source: "document", variable: inCollection[0] };

  const elsewhere = otherVariables.filter((variable) => variable.name === aliasName);
  if (elsewhere.length > 1) {
    throw new Error(
      `aliasName "${aliasName}" matches ${elsewhere.length} variables in other collections (${elsewhere.map((variable) => variable.id).join(", ")}). Use aliasId to pick one.`
    );
  }
  if (elsewhere.length === 1) return { source: "document", variable: elsewhere[0] };

  throw new Error(
    `aliasName "${aliasName}" was not found in this batch, in the target collection, or in another local collection. Check the spelling, or use aliasId.`
  );
};

/** The most items one batch call accepts. */
const MAX_BATCH_ITEMS = 200;

/**
 * Reads the array parameter of a batch tool and checks its size.
 * @param params - The request params.
 * @param key - The parameter name.
 * @param tool - The tool name, for the error message.
 * @returns The raw items, still unexamined.
 */
const readBatchArray = (params: Record<string, unknown>, key: string, tool: string): unknown[] => {
  const raw = params[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${tool} requires ${key} as an array of 1 to ${MAX_BATCH_ITEMS} items.`);
  }
  if (raw.length > MAX_BATCH_ITEMS) {
    throw new Error(
      `${tool} accepts at most ${MAX_BATCH_ITEMS} items per call, received ${raw.length}. Split the batch.`
    );
  }
  return raw;
};

/** What the write phase does with the value of one item. */
type PlannedValue =
  { kind: "value"; value: VariableValue } | { kind: "alias"; target: AliasLookup };

/** One validated item, ready to write. */
type VariablePlan = {
  name: string;
  type: SupportedVariableType;
  planned: PlannedValue;
  scopes?: VariableScope[];
  description?: string;
};

/**
 * Reads the fields that the cross-item checks need from one raw batch item.
 * @param raw - The raw item.
 * @returns The name and type of the item.
 */
const readBatchEntry = (raw: unknown): VariableBatchEntry => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `each item must be an object with name, type, and value, received ${describeValue(raw)}.`
    );
  }
  const { name, type } = raw as { name?: unknown; type?: unknown };
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(
      'name is required and must be a non-empty string. Use "/" to group, for example "color/brand".'
    );
  }
  if (typeof type !== "string" || !isSupportedVariableType(type)) {
    throw new Error(
      `type must be one of ${SUPPORTED_VARIABLE_TYPES.join(", ")}, received ${describeValue(type)}.`
    );
  }
  return { name, type };
};

/**
 * Reads the optional `scopes` field of one raw batch item.
 * @param raw - The raw scopes field.
 * @returns The scopes.
 */
const readScopes = (raw: unknown): VariableScope[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("scopes must be a non-empty array of scope names, or must be left out.");
  }
  return raw.map((scope) => {
    if (typeof scope !== "string") {
      throw new Error(`scopes must hold scope names as strings, received ${describeValue(scope)}.`);
    }
    return scope as VariableScope;
  });
};

/**
 * Creates variables in one collection and writes their values to the default
 * mode of that collection.
 *
 * Every item is examined before the first write, so a batch with a bad item
 * leaves the file untouched. The values are written once every variable
 * exists, which is what lets an item alias a later item of the same batch.
 * @param req - The extension request.
 * @returns One result entry per item.
 */
const createVariables = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "create_variables";
  const collectionId = readRequiredString(req.params, "collectionId", tool);
  const rawItems = readBatchArray(req.params, "variables", tool);

  const collection = await getVariableCollectionById(collectionId);
  const localVariables = await figma.variables.getLocalVariablesAsync();
  const collectionVariables = localVariables.filter(
    (variable) => variable.variableCollectionId === collection.id
  );
  const otherVariables = localVariables.filter(
    (variable) => variable.variableCollectionId !== collection.id
  );

  // Pass one covers the fields the cross-item checks read, because an item may
  // alias any other item by name and needs that item to compare types against.
  const shapeProblems: string[] = [];
  const entries: VariableBatchEntry[] = [];
  rawItems.forEach((raw, index) => {
    try {
      entries.push(readBatchEntry(raw));
    } catch (err) {
      shapeProblems.push(`items[${index}]: ${messageOf(err)}`);
    }
  });
  if (shapeProblems.length > 0) throw validationError(tool, shapeProblems);

  // Pass two covers everything that needs the document or the rest of the
  // batch. Every problem is collected, so one call reports every bad item.
  const problems: string[] = [];
  const plans: VariablePlan[] = [];
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index] as Record<string, unknown>;
    const entry = entries[index];
    const itemProblems: string[] = [];

    if (entries.slice(0, index).some((earlier) => earlier.name === entry.name)) {
      itemProblems.push(
        `name "${entry.name}" is already used by an earlier item of this batch. Every name in a batch must be unique.`
      );
    }
    const clash = collectionVariables.filter((variable) => variable.name === entry.name)[0];
    if (clash) {
      itemProblems.push(
        `name "${entry.name}" already exists in collection "${collection.name}" (${clash.id}). Choose another name.`
      );
    }

    let planned: PlannedValue | undefined;
    let parsed: ParsedVariableValue | undefined;
    try {
      parsed = parseVariableValue(entry.type, raw.value);
    } catch (err) {
      itemProblems.push(messageOf(err));
    }

    if (parsed?.kind === "value") {
      planned = { kind: "value", value: parsed.value };
    } else if (parsed?.kind === "aliasId") {
      const target = await getVariableById(parsed.aliasId);
      if (!target) {
        itemProblems.push(
          `aliasId "${parsed.aliasId}" was not found. Use a variable ID from get_variable_defs.`
        );
      } else if (target.resolvedType !== entry.type) {
        itemProblems.push(
          `alias target "${target.name}" (${target.id}) is a ${target.resolvedType} variable but this item is ${entry.type}. An alias must point at a variable of the same type.`
        );
      } else {
        planned = { kind: "alias", target: { source: "document", variable: target } };
      }
    } else if (parsed?.kind === "aliasName") {
      try {
        const target = findAliasByName(
          parsed.aliasName,
          entries,
          collectionVariables,
          otherVariables
        );
        if (target.source === "batch" && target.index === index) {
          itemProblems.push(
            `value aliases the name of this item, "${entry.name}". Point the alias at another variable.`
          );
        } else if (target.source === "batch" && target.type !== entry.type) {
          itemProblems.push(
            `alias target items[${target.index}] "${parsed.aliasName}" is a ${target.type} variable but this item is ${entry.type}. An alias must point at a variable of the same type.`
          );
        } else if (target.source === "document" && target.variable.resolvedType !== entry.type) {
          itemProblems.push(
            `alias target "${parsed.aliasName}" (${target.variable.id}) is a ${target.variable.resolvedType} variable but this item is ${entry.type}. An alias must point at a variable of the same type.`
          );
        } else {
          planned = { kind: "alias", target };
        }
      } catch (err) {
        itemProblems.push(messageOf(err));
      }
    }

    let scopes: VariableScope[] | undefined;
    if (raw.scopes !== undefined) {
      try {
        scopes = readScopes(raw.scopes);
        validateVariableScopes(entry.type, scopes);
      } catch (err) {
        scopes = undefined;
        itemProblems.push(messageOf(err));
      }
    }

    let description: string | undefined;
    if (raw.description !== undefined) {
      if (typeof raw.description !== "string") {
        itemProblems.push(
          `description must be a string, received ${describeValue(raw.description)}.`
        );
      } else {
        description = raw.description;
      }
    }

    if (itemProblems.length > 0) {
      itemProblems.forEach((problem) => problems.push(`items[${index}]: ${problem}`));
    } else if (planned) {
      plans.push({ name: entry.name, type: entry.type, planned, scopes, description });
    }
  }
  if (problems.length > 0) throw validationError(tool, problems);

  // Pass two records a problem for every item it cannot plan, so from here on
  // the index of a plan is the index of the item it came from.
  const created: Variable[] = [];
  let failedIndex = -1;
  try {
    for (let index = 0; index < plans.length; index++) {
      failedIndex = index;
      created.push(
        figma.variables.createVariable(plans[index].name, collection, plans[index].type)
      );
    }
    for (let index = 0; index < plans.length; index++) {
      failedIndex = index;
      const plan = plans[index];
      if (plan.scopes) created[index].scopes = plan.scopes;
      if (plan.description !== undefined) created[index].description = plan.description;
    }
    for (let index = 0; index < plans.length; index++) {
      failedIndex = index;
      const { planned } = plans[index];
      const value =
        planned.kind === "value"
          ? planned.value
          : figma.variables.createVariableAlias(
              planned.target.source === "batch"
                ? created[planned.target.index]
                : planned.target.variable
            );
      created[index].setValueForMode(collection.defaultModeId, value);
    }
  } catch (err) {
    // A half-written batch is harder to recover from than none at all, so the
    // variables this call created go away again before the error surfaces.
    for (const variable of created) {
      try {
        variable.remove();
      } catch {
        // Already gone with an earlier failure.
      }
    }
    throw describeWriteError(`${tool} wrote nothing, items[${failedIndex}] failed`, err);
  }

  return {
    results: created.map((variable, index) => ({
      index,
      ok: true,
      id: variable.id,
      name: variable.name,
    })),
  };
};

/** One entry of the `results` array a batch tool returns. */
type BatchResult = Record<string, unknown> & { index: number; ok: boolean };

/**
 * Runs the write phase of a batch.
 *
 * Validation has already passed here, so a failure is Figma refusing a write.
 * The call stops at that item: the items before it keep their result, the
 * failed item carries the cause, and every item after it reports that nothing
 * was written for it.
 * @param plans - The validated items, one per input item and in input order.
 * @param write - Writes one item and returns the fields of its result.
 * @returns One result entry per item.
 */
const runBatchWrites = async <TPlan>(
  plans: readonly TPlan[],
  write: (plan: TPlan) => Promise<Record<string, unknown>>
): Promise<{ results: BatchResult[] }> => {
  const results: BatchResult[] = [];
  for (let index = 0; index < plans.length; index++) {
    try {
      results.push({ index, ok: true, ...(await write(plans[index])) });
    } catch (err) {
      results.push({ index, ok: false, error: describeWriteFailure(err) });
      for (let rest = index + 1; rest < plans.length; rest++) {
        results.push({ index: rest, ok: false, error: "not written" });
      }
      break;
    }
  }
  return { results };
};

/**
 * Tests whether a stored variable value is an alias to another variable.
 * @param value - The stored value.
 * @returns True when the value is an alias.
 */
const isVariableAlias = (value: unknown): value is VariableAlias =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value as VariableAlias).type === "VARIABLE_ALIAS";

/** One validated `update_variables` item, ready to write. */
type VariableUpdatePlan = {
  variable: Variable;
  defaultModeId: string;
  name?: string;
  value?: { kind: "value"; value: VariableValue } | { kind: "alias"; variable: Variable };
  scopes?: VariableScope[];
  description?: string;
};

/**
 * Changes the name, value, scopes, or description of existing variables.
 *
 * A value goes to the default mode of the variable's collection, which is the
 * only mode a free plan has. The type of a variable is fixed once it exists,
 * so a value is checked against the type Figma already reports for it.
 *
 * An `aliasName` resolves against the document as it stands, not against the
 * renames of this call, so a batch that renames a variable and aliases it by
 * its old name stays unambiguous.
 * @param req - The extension request.
 * @returns One result entry per item.
 */
const updateVariables = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "update_variables";
  const rawItems = readBatchArray(req.params, "updates", tool);
  const localVariables = await figma.variables.getLocalVariablesAsync();

  const problems: string[] = [];
  const plans: VariableUpdatePlan[] = [];
  /** Variable ID to the index of the item that already updates it. */
  const claimedVariables = new Map<string, number>();
  /** Collection ID to new name to the index of the item that already takes it. */
  const claimedNames = new Map<string, Map<string, number>>();

  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];
    const fail = (problem: string) => problems.push(`items[${index}]: ${problem}`);

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(
        `each item must be an object with variableId and at least one of name, value, scopes, or description, received ${describeValue(raw)}.`
      );
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.variableId !== "string" || item.variableId.trim() === "") {
      fail(
        'variableId is required and must be a variable ID such as "VariableID:1:2". Call get_variable_defs to list them.'
      );
      continue;
    }
    const variable = await getVariableById(item.variableId);
    if (!variable) {
      fail(
        `variable not found: ${item.variableId}. Call get_variable_defs to list the variable IDs of this file.`
      );
      continue;
    }
    if (!isSupportedVariableType(variable.resolvedType)) {
      fail(
        `"${variable.name}" is a ${variable.resolvedType} variable, which these tools do not write. They write ${SUPPORTED_VARIABLE_TYPES.join(", ")}.`
      );
      continue;
    }
    const type = variable.resolvedType;

    let collection: VariableCollection;
    try {
      collection = await getVariableCollectionById(variable.variableCollectionId);
    } catch (err) {
      fail(messageOf(err));
      continue;
    }

    const itemProblems: string[] = [];
    const claimed = claimedVariables.get(variable.id);
    if (claimed !== undefined) {
      itemProblems.push(
        `${variable.id} is already updated by items[${claimed}]. Give each variable at most one item.`
      );
    } else {
      claimedVariables.set(variable.id, index);
    }

    if (
      item.name === undefined &&
      item.value === undefined &&
      item.scopes === undefined &&
      item.description === undefined
    ) {
      itemProblems.push(
        "an item needs at least one of name, value, scopes, or description. An item that carries only variableId changes nothing."
      );
    }

    let name: string | undefined;
    if (item.name !== undefined) {
      if (typeof item.name !== "string" || item.name.trim() === "") {
        itemProblems.push(
          'name must be a non-empty string. Use "/" to group, for example "color/brand".'
        );
      } else {
        name = item.name;
        const clash = localVariables.filter(
          (other) =>
            other.variableCollectionId === variable.variableCollectionId &&
            other.name === name &&
            other.id !== variable.id
        )[0];
        if (clash) {
          itemProblems.push(
            `name "${name}" already exists in collection "${collection.name}" (${clash.id}). Choose another name.`
          );
        }
        const namesInCollection =
          claimedNames.get(variable.variableCollectionId) ?? new Map<string, number>();
        claimedNames.set(variable.variableCollectionId, namesInCollection);
        const takenBy = namesInCollection.get(name);
        if (takenBy !== undefined) {
          itemProblems.push(
            `name "${name}" is already taken by items[${takenBy}] in the same collection. Every new name in a batch must be unique.`
          );
        } else {
          namesInCollection.set(name, index);
        }
      }
    }

    let value: VariableUpdatePlan["value"];
    if (item.value !== undefined) {
      try {
        const parsed = parseVariableValue(type, item.value);
        if (parsed.kind === "value") {
          value = { kind: "value", value: parsed.value };
        } else {
          let target: Variable | null = null;
          if (parsed.kind === "aliasId") {
            target = await getVariableById(parsed.aliasId);
            if (!target) {
              itemProblems.push(
                `aliasId "${parsed.aliasId}" was not found. Use a variable ID from get_variable_defs.`
              );
            }
          } else {
            // The batch argument is empty: an update names variables that
            // already exist, so every alias target already has an ID.
            const lookup = findAliasByName(
              parsed.aliasName,
              [],
              localVariables.filter(
                (other) => other.variableCollectionId === variable.variableCollectionId
              ),
              localVariables.filter(
                (other) => other.variableCollectionId !== variable.variableCollectionId
              )
            );
            target = lookup.source === "document" ? lookup.variable : null;
          }
          if (target && target.id === variable.id) {
            itemProblems.push(
              `value aliases the variable this item updates, "${variable.name}" (${variable.id}). Point the alias at another variable.`
            );
          } else if (target && target.resolvedType !== type) {
            itemProblems.push(
              `alias target "${target.name}" (${target.id}) is a ${target.resolvedType} variable but "${variable.name}" is ${type}. An alias must point at a variable of the same type.`
            );
          } else if (target) {
            value = { kind: "alias", variable: target };
          }
        }
      } catch (err) {
        itemProblems.push(messageOf(err));
      }
    }

    let scopes: VariableScope[] | undefined;
    if (item.scopes !== undefined) {
      try {
        scopes = readScopes(item.scopes);
        validateVariableScopes(type, scopes);
      } catch (err) {
        scopes = undefined;
        itemProblems.push(messageOf(err));
      }
    }

    let description: string | undefined;
    if (item.description !== undefined) {
      if (typeof item.description !== "string") {
        itemProblems.push(
          `description must be a string, received ${describeValue(item.description)}.`
        );
      } else {
        description = item.description;
      }
    }

    if (itemProblems.length > 0) {
      itemProblems.forEach(fail);
    } else {
      plans.push({
        variable,
        defaultModeId: collection.defaultModeId,
        name,
        value,
        scopes,
        description,
      });
    }
  }
  if (problems.length > 0) throw validationError(tool, problems);

  return runBatchWrites(plans, async (plan) => {
    if (plan.name !== undefined) plan.variable.name = plan.name;
    if (plan.scopes) plan.variable.scopes = plan.scopes;
    if (plan.description !== undefined) plan.variable.description = plan.description;
    if (plan.value) {
      plan.variable.setValueForMode(
        plan.defaultModeId,
        plan.value.kind === "value"
          ? plan.value.value
          : figma.variables.createVariableAlias(plan.value.variable)
      );
    }
    return { id: plan.variable.id, name: plan.variable.name };
  });
};

/**
 * Finds the local variables that alias one target, in any mode.
 *
 * Figma leaves such a variable without a target once the removal goes through,
 * so `delete_variables` reports them instead of breaking them silently.
 * @param localVariables - Every local variable of the file.
 * @param targetId - The variable about to be removed.
 * @returns The IDs of the variables that point at the target.
 */
const findAliasSources = (localVariables: readonly Variable[], targetId: string): string[] =>
  localVariables
    .filter(
      (variable) =>
        variable.id !== targetId &&
        Object.values(variable.valuesByMode).some(
          (value) => isVariableAlias(value) && value.id === targetId
        )
    )
    .map((variable) => variable.id);

/**
 * Removes variables, and reports what aliased each of them.
 *
 * The alias sources are read before the first removal, because a removed
 * variable cannot be looked up afterwards.
 * @param req - The extension request.
 * @returns One result entry per item.
 */
const deleteVariables = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "delete_variables";
  if (req.params.confirm !== true) {
    throw new Error(
      `${tool} requires confirm: true. It removes each variable, and any node or variable bound to one of them keeps its last resolved value.`
    );
  }
  const rawIds = readBatchArray(req.params, "variableIds", tool);
  const localVariables = await figma.variables.getLocalVariablesAsync();

  const problems: string[] = [];
  const plans: { variable: Variable; aliasedBy: string[] }[] = [];
  const claimed = new Map<string, number>();

  for (let index = 0; index < rawIds.length; index++) {
    const raw = rawIds[index];
    if (typeof raw !== "string" || raw.trim() === "") {
      problems.push(
        `items[${index}]: each entry must be a variable ID such as "VariableID:1:2", received ${describeValue(raw)}.`
      );
      continue;
    }
    const variable = await getVariableById(raw);
    if (!variable) {
      problems.push(
        `items[${index}]: variable not found: ${raw}. Call get_variable_defs to list the variable IDs of this file.`
      );
      continue;
    }
    const duplicate = claimed.get(variable.id);
    if (duplicate !== undefined) {
      problems.push(
        `items[${index}]: ${variable.id} is already listed at items[${duplicate}]. List each variable once.`
      );
      continue;
    }
    claimed.set(variable.id, index);
    plans.push({ variable, aliasedBy: findAliasSources(localVariables, variable.id) });
  }
  if (problems.length > 0) throw validationError(tool, problems);

  return runBatchWrites(plans, async (plan) => {
    // Read before the removal: the object throws on every property access once
    // it is gone.
    const id = plan.variable.id;
    plan.variable.remove();
    return { id, aliasedBy: plan.aliasedBy };
  });
};

export const variablesHandlers = {
  create_variable_collection: { edit: true, run: createVariableCollection },
  update_variable_collection: { edit: true, run: updateVariableCollection },
  delete_variable_collection: { edit: true, run: deleteVariableCollection },
  create_variables: { edit: true, run: createVariables },
  update_variables: { edit: true, run: updateVariables },
  delete_variables: { edit: true, run: deleteVariables },
} satisfies Record<string, ExtensionHandler>;
