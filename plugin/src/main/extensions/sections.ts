import { pageOf, parseHexColor } from "../shared";
import {
  describeValue,
  describeWriteError,
  messageOf,
  readBatchArray,
  readOptionalNumber,
  readOptionalString,
  validationError,
} from "./batch";
import type { ExtensionHandler, ExtensionRequest } from "./types";

/**
 * Section tools.
 *
 * Add a tool by adding one entry here. Set `edit` to true when the handler
 * writes to the file.
 *
 * A section is the one container Figma places outside the frame tree: its
 * parent is a page or another section, never a frame, a group, a component, or
 * an instance. It also leaves its children where they are when it resizes, so
 * the bounds a section reports and the bounds of what it holds are two
 * different things — which is why the read tools report both.
 */

/** How many items list_sections returns by default, and at most. */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

/** The most children get_section lists, and the most overflow IDs it names. */
const MAX_CHILDREN_LISTED = 200;

/** The margin create_section leaves around the nodes it wraps. */
const DEFAULT_WRAP_PADDING = 80;

/** The smallest side Figma accepts when a section is resized. */
const MIN_SECTION_SIZE = 0.01;

/**
 * How far a child may cross a section edge before it counts as overflowing.
 *
 * The comparison runs on absolute coordinates, so a child laid flush against
 * an edge lands a rounding error either side of it and would otherwise be
 * reported as escaping the section it fits exactly.
 */
const OVERFLOW_TOLERANCE = 0.01;

/**
 * Reads the node ID a section tool acts on.
 * @param req - The extension request.
 * @param tool - The tool name, for the error message.
 * @param what - What the node is, for the error message.
 * @returns The node ID.
 */
const readNodeId = (req: ExtensionRequest, tool: string, what: string): string => {
  const nodeId = req.nodeIds && req.nodeIds[0];
  if (typeof nodeId !== "string" || nodeId.trim() === "") {
    throw new Error(
      `${tool} requires nodeId, ${what}. Call list_sections to list the sections of this file.`
    );
  }
  return nodeId;
};

/**
 * Looks one section up.
 * @param nodeId - The node ID.
 * @param tool - The tool name, for the error message.
 * @returns The section.
 */
const readSectionById = async (nodeId: string, tool: string): Promise<SectionNode> => {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(
      `${tool} found no node with the ID ${nodeId}. Call list_sections or get_document to list the node IDs of this file.`
    );
  }
  if (node.type !== "SECTION") {
    throw new Error(
      `${nodeId} "${node.name}" is a ${node.type} node, not a SECTION. ${tool} reads a section; call get_node for any other node.`
    );
  }
  return node;
};

/**
 * The sections a node sits inside, nearest first.
 *
 * Only a page or another section holds a section, so for a section this chain
 * is also how deeply it is nested.
 * @param node - The node to walk up from.
 * @returns The sections around it, nearest first.
 */
const sectionAncestorsOf = (node: SceneNode): SectionNode[] => {
  const chain: SectionNode[] = [];
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === "SECTION") chain.push(current);
    current = current.parent;
  }
  return chain;
};

/** A container a section can sit in, and that a section's children sit in. */
type SectionParent = PageNode | SectionNode;

/**
 * The absolute position a container's children measure from.
 *
 * Read off `absoluteTransform` rather than `absoluteBoundingBox`, which is
 * nullable. A section does not rotate, so the two agree; a page is the canvas
 * origin itself.
 * @param container - The page or section.
 * @returns Its absolute x and y.
 */
const absoluteOriginOf = (container: SectionParent): { x: number; y: number } => {
  if (container.type === "PAGE") return { x: 0, y: 0 };
  const transform = container.absoluteTransform;
  return { x: transform[0][2], y: transform[1][2] };
};

/**
 * Loads a page so its children can be read and written.
 *
 * Under `documentAccess: "dynamic-page"` a page's contents stay unloaded until
 * they are asked for, and a section has one.
 * @param container - The page or section.
 */
const loadIfPage = async (container: SectionParent): Promise<void> => {
  if (container.type === "PAGE") await container.loadAsync();
};

/**
 * Moves a node into a container and leaves it where it is on the canvas.
 *
 * `appendChild` keeps the node's own x and y, which are read against whatever
 * parent it has, so a plain move slides the node by the distance between the
 * old parent and the new one. Reading `absoluteTransform` before the move and
 * writing it back as `relativeTransform` afterwards, less the new parent's own
 * absolute position, puts the node back where the user left it. Neither a page
 * nor a section rotates, so the rest of the transform carries across as it is.
 * @param node - The node to move.
 * @param parent - The page or section to move it into.
 */
const moveKeepingCanvasPosition = (node: SceneNode, parent: SectionParent): void => {
  const before = node.absoluteTransform;
  parent.appendChild(node);
  const origin = absoluteOriginOf(parent);
  node.relativeTransform = [
    [before[0][0], before[0][1], before[0][2] - origin.x],
    [before[1][0], before[1][1], before[1][2] - origin.y],
  ];
};

/**
 * Lists the sections of a page or of the whole file.
 * @param req - The extension request.
 * @returns The items and whether the limit cut the list short.
 */
const listSections = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "list_sections";
  const rawScope = readOptionalString(req.params, "scope", tool);
  if (rawScope !== undefined && rawScope !== "currentPage" && rawScope !== "allPages") {
    throw new Error(
      `${tool} requires scope to be currentPage or allPages, received "${rawScope}". currentPage reads the page open in Figma, allPages the whole file.`
    );
  }
  const query = readOptionalString(req.params, "query", tool);

  let limit = DEFAULT_LIST_LIMIT;
  const rawLimit = req.params.limit;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1) {
      throw new Error(
        `${tool} requires limit as a whole number of 1 or more, received ${describeValue(rawLimit)}.`
      );
    }
    limit = Math.min(rawLimit, MAX_LIST_LIMIT);
  }

  let found: readonly (PageNode | SceneNode)[];
  if (rawScope === "allPages") {
    // Under `dynamic-page` a page's contents stay unloaded until they are
    // asked for, and searching the document is refused until every page is.
    await figma.loadAllPagesAsync();
    found = figma.root.findAllWithCriteria({ types: ["SECTION"] });
  } else {
    found = figma.currentPage.findAllWithCriteria({ types: ["SECTION"] });
  }

  const needle = query === undefined ? "" : query.trim().toLowerCase();
  // `findAllWithCriteria` walks back to front and parent before child, page by
  // page in page order, so the order it returns is already the order asked
  // for: by page, then by document order. A nested section therefore follows
  // the section that holds it.
  const matched = found
    .filter((node): node is SectionNode => node.type === "SECTION")
    .filter((node) => needle === "" || node.name.toLowerCase().includes(needle));

  const items = matched.slice(0, limit).map((node) => {
    const page = pageOf(node);
    const ancestors = sectionAncestorsOf(node);
    return {
      id: node.id,
      name: node.name,
      pageId: page ? page.id : null,
      pageName: page ? page.name : null,
      parentSectionId: ancestors.length > 0 ? ancestors[0].id : null,
      depth: ancestors.length,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      childCount: node.children.length,
      contentsHidden: node.sectionContentsHidden,
    };
  });

  return { items, truncated: matched.length > limit };
};

/**
 * Reads one section: what it holds, where that content really sits, and what
 * has been left hanging outside it.
 *
 * A section does not clip and does not move its children when it resizes, so a
 * child can sit wholly outside the section that owns it and still be drawn.
 * `contentBounds` is where the content actually is, and `overflowIds` names
 * the children that escaped — both measured over every visible child, not only
 * the ones the `children` list had room for.
 * @param req - The extension request.
 * @returns The section.
 */
const getSection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "get_section";
  const nodeId = readNodeId(req, tool, "the section to read");
  const node = await readSectionById(nodeId, tool);

  const page = pageOf(node);
  const parent = node.parent;
  const origin = absoluteOriginOf(node);
  const children = node.children;

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let measured = 0;
  let overflowCount = 0;
  const overflowIds: string[] = [];

  for (const child of children) {
    if (!child.visible) continue;
    const box = child.absoluteBoundingBox;
    if (!box) continue;

    if (measured === 0) {
      minX = box.x;
      minY = box.y;
      maxX = box.x + box.width;
      maxY = box.y + box.height;
    } else {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    measured++;

    const escapes =
      box.x < origin.x - OVERFLOW_TOLERANCE ||
      box.y < origin.y - OVERFLOW_TOLERANCE ||
      box.x + box.width > origin.x + node.width + OVERFLOW_TOLERANCE ||
      box.y + box.height > origin.y + node.height + OVERFLOW_TOLERANCE;
    if (escapes) {
      overflowCount++;
      if (overflowIds.length < MAX_CHILDREN_LISTED) overflowIds.push(child.id);
    }
  }

  return {
    id: node.id,
    name: node.name,
    pageId: page ? page.id : null,
    pageName: page ? page.name : null,
    parentId: parent ? parent.id : null,
    parentType: parent ? parent.type : null,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    absoluteX: origin.x,
    absoluteY: origin.y,
    contentsHidden: node.sectionContentsHidden,
    childCount: children.length,
    children: children.slice(0, MAX_CHILDREN_LISTED).map((child) => ({
      id: child.id,
      name: child.name,
      type: child.type,
      x: child.x,
      y: child.y,
      width: child.width,
      height: child.height,
      visible: child.visible,
    })),
    truncated: children.length > MAX_CHILDREN_LISTED,
    contentBounds:
      measured === 0
        ? null
        : {
            x: minX - origin.x,
            y: minY - origin.y,
            width: maxX - minX,
            height: maxY - minY,
          },
    overflowCount,
    overflowIds,
  };
};

/**
 * The fields of a section a create call reports back.
 * @param section - The new section.
 * @returns The result object.
 */
const describeCreatedSection = (section: SectionNode): Record<string, unknown> => ({
  id: section.id,
  name: section.name,
  parentId: section.parent ? section.parent.id : null,
  x: section.x,
  y: section.y,
  width: section.width,
  height: section.height,
  childIds: section.children.map((child) => child.id),
});

/**
 * Refuses a parameter that belongs to the other form of create_section.
 * @param params - The request params.
 * @param keys - The parameters this form does not take.
 * @param tool - The tool name, for the error message.
 * @param correction - What to do instead.
 */
const refuseParams = (
  params: Record<string, unknown>,
  keys: readonly string[],
  tool: string,
  correction: string
): void => {
  for (const key of keys) {
    if (params[key] !== undefined && params[key] !== null) {
      throw new Error(`${tool} does not take ${key} in this form. ${correction}`);
    }
  }
};

/**
 * Resolves the container a new section goes into.
 *
 * Figma keeps a section outside the frame tree, so only a page or another
 * section can hold one.
 * @param parentId - The `parentId` parameter.
 * @param tool - The tool name, for the error message.
 * @returns The page or section.
 */
const readSectionParentById = async (parentId: string, tool: string): Promise<SectionParent> => {
  const parent = await figma.getNodeByIdAsync(parentId);
  if (!parent) {
    throw new Error(
      `${tool} found no node with the ID ${parentId} for parentId. Call get_metadata to list the pages of this file, or list_sections to list its sections.`
    );
  }
  if (parent.type !== "PAGE" && parent.type !== "SECTION") {
    throw new Error(
      `${tool} requires parentId to name a page or a SECTION, but ${parentId} "${parent.name}" is a ${parent.type} node. Figma keeps a section outside the frame tree, so it cannot go in a frame, a group, a component, or an instance: pass a page ID from get_metadata, a section ID from list_sections, or leave parentId out to use the current page.`
    );
  }
  await loadIfPage(parent);
  return parent;
};

/**
 * Creates an empty section of a given size.
 * @param req - The extension request.
 * @param tool - The tool name.
 * @param name - The `name` parameter, already read.
 * @param fillHex - The `fillHex` parameter, already read.
 * @returns The new section.
 */
const createEmptySection = async (
  req: ExtensionRequest,
  tool: string,
  name: string | undefined,
  fillHex: string | undefined
): Promise<unknown> => {
  refuseParams(
    req.params,
    ["padding"],
    tool,
    "padding is the margin left around the nodes nodeIds names; an empty section takes width and height instead."
  );

  const width = readOptionalNumber(req.params, "width", tool, MIN_SECTION_SIZE);
  const height = readOptionalNumber(req.params, "height", tool, MIN_SECTION_SIZE);
  if (width === undefined || height === undefined) {
    throw new Error(
      `${tool} needs width and height to make an empty section, or nodeIds to wrap nodes in one. Received neither.`
    );
  }
  const x = readOptionalNumber(req.params, "x", tool) ?? 0;
  const y = readOptionalNumber(req.params, "y", tool) ?? 0;
  const parentId = readOptionalString(req.params, "parentId", tool);

  // Everything is checked and resolved before the first write, so a call that
  // is refused leaves the file as it was.
  const fill = fillHex === undefined ? undefined : parseHexColor(fillHex);
  const parent =
    parentId === undefined ? figma.currentPage : await readSectionParentById(parentId, tool);

  let section: SectionNode | null = null;
  try {
    section = figma.createSection();
    section.resizeWithoutConstraints(width, height);
    if (fill) section.fills = [{ type: "SOLID", color: fill }];
    if (name !== undefined) section.name = name;
    // `createSection` drops the section on the page open in Figma, which is
    // not always the page being built, so the move comes before the position:
    // x and y are read against whichever parent the section ends up in.
    parent.appendChild(section);
    section.x = x;
    section.y = y;
  } catch (err) {
    if (section && !section.removed) section.remove();
    throw describeWriteError(`${tool} could not create the section`, err);
  }

  return describeCreatedSection(section);
};

/** One checked node on its way into a new section. */
type WrapPlan = {
  index: number;
  node: SceneNode;
  box: Rect;
  /** Where the node sat in its parent, so a failed wrap can put it back. */
  stackIndex: number;
  transform: Transform;
};

/**
 * Puts the wrapped nodes back where they were and removes the new section.
 * @param section - The new section, if it was created.
 * @param parent - The container the nodes came from.
 * @param moved - The nodes already moved, in ascending stack order.
 * @returns Null when the file is as it was, or why it could not be restored.
 */
const rollbackWrap = (
  section: SectionNode | null,
  parent: SectionParent,
  moved: readonly WrapPlan[]
): string | null => {
  try {
    // The section goes to the top of the stack first: below it the indices are
    // then the ones the nodes were read at, and `remove` would otherwise take
    // the nodes still inside it along.
    if (section && !section.removed && section.parent && section.parent.id === parent.id) {
      parent.appendChild(section);
    }
    for (const plan of moved) {
      parent.insertChild(plan.stackIndex, plan.node);
      plan.node.relativeTransform = plan.transform;
    }
    if (section && !section.removed) section.remove();
    return null;
  } catch (err) {
    return messageOf(err);
  }
};

/**
 * Wraps nodes in a new section that keeps them where they are.
 *
 * The nodes have to share one parent, and that parent has to be a page or a
 * section, because that is where Figma allows the new section to go. Every
 * node is checked before the first write, and a write that fails afterwards is
 * undone: the nodes go back to their old stack position and transform, and the
 * section is removed. A half-wrapped page is worse than no section at all.
 * @param req - The extension request.
 * @param tool - The tool name.
 * @param name - The `name` parameter, already read.
 * @param fillHex - The `fillHex` parameter, already read.
 * @returns The new section.
 */
const wrapInSection = async (
  req: ExtensionRequest,
  tool: string,
  name: string | undefined,
  fillHex: string | undefined
): Promise<unknown> => {
  refuseParams(
    req.params,
    ["parentId", "x", "y", "width", "height"],
    tool,
    "The wrapped nodes decide where the section goes and how big it is. Drop the field, or drop nodeIds and give width and height for an empty section."
  );

  // The node IDs travel in the request's own `nodeIds` field, as they do for
  // the core tools that take a list of nodes, not among the params.
  const rawNodeIds = readBatchArray({ nodeIds: req.nodeIds }, "nodeIds", tool);
  const padding = readOptionalNumber(req.params, "padding", tool, 0) ?? DEFAULT_WRAP_PADDING;
  const fill = fillHex === undefined ? undefined : parseHexColor(fillHex);

  const problems: string[] = [];
  const plans: WrapPlan[] = [];
  const seen = new Set<string>();
  let parent: SectionParent | null = null;

  for (let index = 0; index < rawNodeIds.length; index++) {
    const rawNodeId = rawNodeIds[index];
    const fail = (problem: string): void => {
      problems.push(`items[${index}]: ${problem}`);
    };

    if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
      fail(
        `each item must be a node ID such as "4029:12345", received ${describeValue(rawNodeId)}. Call get_document or get_selection to list them.`
      );
      continue;
    }
    if (seen.has(rawNodeId)) {
      fail(`${rawNodeId} is named more than once. Give each node one time.`);
      continue;
    }
    seen.add(rawNodeId);

    const node = await figma.getNodeByIdAsync(rawNodeId);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      fail(
        `${rawNodeId} is no node of this file, or names a page rather than a node on one. Call get_document or get_selection to list the node IDs of this page.`
      );
      continue;
    }

    const holder = node.parent;
    if (!holder || (holder.type !== "PAGE" && holder.type !== "SECTION")) {
      fail(
        `${rawNodeId} "${node.name}" sits in ${holder ? `the ${holder.type} ${holder.id} "${holder.name}"` : "nothing"}, and Figma keeps a section outside the frame tree, so no section can wrap it there. Move it onto a page or into a section with reparent_nodes, or wrap the ${holder ? holder.type : "parent"} itself.`
      );
      continue;
    }
    if (parent === null) {
      parent = holder;
      await loadIfPage(parent);
    } else if (holder.id !== parent.id) {
      fail(
        `${rawNodeId} "${node.name}" sits in the ${holder.type} ${holder.id} "${holder.name}", while the first node sits in the ${parent.type} ${parent.id} "${parent.name}". One section wraps the nodes of one parent: call reparent_nodes first, or wrap them in two calls.`
      );
      continue;
    }

    const box = node.absoluteBoundingBox;
    if (!box) {
      fail(
        `${rawNodeId} "${node.name}" reports no bounds, so the section around it cannot be measured. Leave it out of the call.`
      );
      continue;
    }

    plans.push({ index, node, box, stackIndex: 0, transform: node.relativeTransform });
  }

  if (problems.length > 0) throw validationError(tool, problems);
  if (parent === null || plans.length === 0) {
    throw validationError(tool, ["items[0]: no node was read."]);
  }

  // The stack positions are read once, before anything moves: the section
  // takes the place of the lowest node, and the nodes keep their order.
  const stackOf = new Map<string, number>();
  parent.children.forEach((child, at) => stackOf.set(child.id, at));
  for (const plan of plans) plan.stackIndex = stackOf.get(plan.node.id) ?? 0;
  const inStackOrder = [...plans].sort((a, b) => a.stackIndex - b.stackIndex);
  const lowest = inStackOrder[0].stackIndex;

  let minX = plans[0].box.x;
  let minY = plans[0].box.y;
  let maxX = plans[0].box.x + plans[0].box.width;
  let maxY = plans[0].box.y + plans[0].box.height;
  for (const plan of plans) {
    minX = Math.min(minX, plan.box.x);
    minY = Math.min(minY, plan.box.y);
    maxX = Math.max(maxX, plan.box.x + plan.box.width);
    maxY = Math.max(maxY, plan.box.y + plan.box.height);
  }
  const width = Math.max(MIN_SECTION_SIZE, maxX - minX + padding * 2);
  const height = Math.max(MIN_SECTION_SIZE, maxY - minY + padding * 2);
  const origin = absoluteOriginOf(parent);

  const moved: WrapPlan[] = [];
  let section: SectionNode | null = null;
  try {
    section = figma.createSection();
    section.resizeWithoutConstraints(width, height);
    if (fill) section.fills = [{ type: "SOLID", color: fill }];
    if (name !== undefined) section.name = name;
    // Into the parent before it is positioned, because x and y are read
    // against it, and at the stack position of the lowest node: every node
    // leaving the parent afterwards sat above that, so the place holds.
    parent.insertChild(lowest, section);
    section.x = minX - padding - origin.x;
    section.y = minY - padding - origin.y;

    for (const plan of inStackOrder) {
      moveKeepingCanvasPosition(plan.node, section);
      moved.push(plan);
    }
  } catch (err) {
    const failure = describeWriteError(
      `${tool} could not wrap ${plans.length === 1 ? "the node" : `these ${plans.length} nodes`} in a section`,
      err
    );
    const notRestored = rollbackWrap(section, parent, moved);
    if (notRestored === null) throw failure;
    throw new Error(
      `${failure.message} The nodes could not be put back either: ${notRestored}. Read the page with get_document before calling it again.`
    );
  }

  return describeCreatedSection(section);
};

/**
 * Creates a section, either empty at a given size or around existing nodes.
 * @param req - The extension request.
 * @returns The new section.
 */
const createSection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "create_section";
  const name = readOptionalString(req.params, "name", tool);
  const fillHex = readOptionalString(req.params, "fillHex", tool);
  const wrapping = req.nodeIds !== undefined && req.nodeIds !== null;
  return wrapping
    ? await wrapInSection(req, tool, name, fillHex)
    : await createEmptySection(req, tool, name, fillHex);
};

export const sectionsHandlers = {
  list_sections: { edit: false, run: listSections },
  get_section: { edit: false, run: getSection },
  create_section: { edit: true, run: createSection },
} satisfies Record<string, ExtensionHandler>;
