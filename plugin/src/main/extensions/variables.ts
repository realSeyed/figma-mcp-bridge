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
 * @param action - What the handler was doing, phrased for a message.
 * @param err - The error Figma threw.
 * @returns The error to throw on.
 */
const describeWriteError = (action: string, err: unknown): Error => {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(limit|plan|upgrade|professional|organization|enterprise|subscri\w*)\b/i.test(message)) {
    return new Error(
      `${action}: ${message}. This is a Figma plan limit. A free (Starter) account keeps one mode per collection and cannot publish a library or use extended collections; a paid plan lifts the limit.`
    );
  }
  return new Error(`${action}: ${message}.`);
};

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

export const variablesHandlers = {
  create_variable_collection: { edit: true, run: createVariableCollection },
  update_variable_collection: { edit: true, run: updateVariableCollection },
  delete_variable_collection: { edit: true, run: deleteVariableCollection },
} satisfies Record<string, ExtensionHandler>;
