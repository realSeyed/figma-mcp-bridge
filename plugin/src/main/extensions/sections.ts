import {
  absoluteOriginOf,
  ancestorIdsOf,
  loadIfPage,
  moveKeepingCanvasPosition,
  pageOf,
  parseHexColor,
  sectionAncestorsOf,
  supportsChildren,
} from "../shared";
import type { SectionParent } from "../shared";
import {
  describeValue,
  describeWriteError,
  messageOf,
  readBatchArray,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
  runBatchWrites,
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

/** The margin create_section, move_to_section, and fit_section leave around content. */
const DEFAULT_PADDING = 80;

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
const readSectionById = async (
  nodeId: string,
  tool: string,
  field = "nodeId"
): Promise<SectionNode> => {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(
      `${tool} found no node with the ID ${nodeId} for ${field}. Call list_sections or get_document to list the node IDs of this file.`
    );
  }
  if (node.type !== "SECTION") {
    throw new Error(
      `${tool} requires ${field} to name a SECTION, but ${nodeId} "${node.name}" is a ${node.type} node. Call list_sections for a section ID, or get_node to read this node instead.`
    );
  }
  return node;
};

/**
 * The instance a node sits inside, if any.
 * @param node - The node to walk up from.
 * @returns The nearest instance above it, or null.
 */
const instanceAncestorOf = (node: SceneNode): InstanceNode | null => {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.type === "INSTANCE") return current;
    current = current.parent;
  }
  return null;
};

/**
 * Where a node sits in the stack of its page, as one index per level.
 *
 * The nodes of one call can come from different parents, so their stack order
 * is only defined over the page they share. Comparing two of these paths walks
 * them together: the first index that differs decides, and a shorter path that
 * matches all the way belongs to an ancestor, which Figma draws below its own
 * children.
 * @param node - The node to place.
 * @returns The index path, outermost first.
 */
const documentOrderKeyOf = (node: SceneNode): number[] => {
  const path: number[] = [];
  let current: BaseNode = node;
  while (current.parent) {
    const parent: BaseNode = current.parent;
    const child = current;
    path.push(
      supportsChildren(parent) ? parent.children.findIndex((each) => each.id === child.id) : 0
    );
    current = parent;
  }
  return path.reverse();
};

/**
 * Orders two nodes by where they sit in the stack of their page.
 * @param a - The path of the first node.
 * @param b - The path of the second node.
 * @returns A negative number when the first node is drawn below the second.
 */
const compareDocumentOrder = (a: readonly number[], b: readonly number[]): number => {
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at++) {
    if (a[at] !== b[at]) return a[at] - b[at];
  }
  return a.length - b.length;
};

/** The box, on the canvas, that a section's visible children occupy. */
type ContentBounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Measures the visible children of a section on the canvas.
 *
 * A hidden child is left out, and so is a child that reports no bounds, which
 * is why the result is nullable rather than a zero-sized box: a section with
 * nothing to measure is a different answer from one whose content has no size.
 * @param section - The section to measure.
 * @returns The absolute box, or null when nothing could be measured.
 */
const measureVisibleContents = (section: SectionNode): ContentBounds | null => {
  let bounds: ContentBounds | null = null;
  for (const child of section.children) {
    if (!child.visible) continue;
    const box = child.absoluteBoundingBox;
    if (!box) continue;
    bounds =
      bounds === null
        ? { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }
        : {
            minX: Math.min(bounds.minX, box.x),
            minY: Math.min(bounds.minY, box.y),
            maxX: Math.max(bounds.maxX, box.x + box.width),
            maxY: Math.max(bounds.maxY, box.y + box.height),
          };
  }
  return bounds;
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
  const bounds = measureVisibleContents(node);

  let overflowCount = 0;
  const overflowIds: string[] = [];

  for (const child of children) {
    if (!child.visible) continue;
    const box = child.absoluteBoundingBox;
    if (!box) continue;

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
      bounds === null
        ? null
        : {
            x: bounds.minX - origin.x,
            y: bounds.minY - origin.y,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY,
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
  const padding = readOptionalNumber(req.params, "padding", tool, 0) ?? DEFAULT_PADDING;
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

/**
 * The box a section reports after a call that moved or resized it.
 * @param section - The section.
 * @returns The result object.
 */
const describeSectionBox = (section: SectionNode): Record<string, unknown> => ({
  id: section.id,
  x: section.x,
  y: section.y,
  width: section.width,
  height: section.height,
});

/**
 * Draws a section tight around what it holds, leaving a margin.
 *
 * A section carries its children when it moves but leaves them where they are
 * when it resizes, so a fit is two writes that cancel out on the canvas: the
 * section takes the box of its visible content grown by `padding`, and every
 * child then slides back by the distance the section travelled. A hidden child
 * is measured out of the box but slides back with the rest, since it would
 * otherwise be the one thing the call moved.
 *
 * `move_to_section` calls this too, so the fit a move performs and the fit
 * `fit_section` performs are the same operation.
 * @param section - The section to fit.
 * @param padding - The margin to leave on each side, in pixels.
 * @param tool - The tool name, for the error message.
 */
const fitSectionToContents = (section: SectionNode, padding: number, tool: string): void => {
  const bounds = measureVisibleContents(section);
  if (bounds === null) {
    const why =
      section.children.length === 0
        ? "it holds no child"
        : `all ${section.children.length} of its children are hidden`;
    throw new Error(
      `${tool} sizes a section to the children it holds, and ${section.id} "${section.name}" has none to measure: ${why}. Move nodes in with move_to_section, or show a child with set_node_visibility, then call it again.`
    );
  }

  // How far the section's own top-left travels. Neither a page nor a section
  // rotates, so this canvas distance is also the distance in the coordinates
  // of the parent, and in the coordinates the children are read against.
  const origin = absoluteOriginOf(section);
  const dx = bounds.minX - padding - origin.x;
  const dy = bounds.minY - padding - origin.y;
  const width = Math.max(MIN_SECTION_SIZE, bounds.maxX - bounds.minX + padding * 2);
  const height = Math.max(MIN_SECTION_SIZE, bounds.maxY - bounds.minY + padding * 2);

  try {
    section.resizeWithoutConstraints(width, height);
    section.x = section.x + dx;
    section.y = section.y + dy;
    for (const child of section.children) {
      child.x = child.x - dx;
      child.y = child.y - dy;
    }
  } catch (err) {
    throw describeWriteError(
      `${tool} could not fit ${section.id} "${section.name}" around its children`,
      err
    );
  }
};

/**
 * Sizes a section to the children it holds.
 * @param req - The extension request.
 * @returns The section's box after the fit.
 */
const fitSection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "fit_section";
  const nodeId = readNodeId(req, tool, "the section to fit");
  const padding = readOptionalNumber(req.params, "padding", tool, 0) ?? DEFAULT_PADDING;
  const section = await readSectionById(nodeId, tool);
  fitSectionToContents(section, padding, tool);
  return describeSectionBox(section);
};

/** One checked node on its way into a section. */
type MovePlan = {
  node: SceneNode;
  /** True when the node already hangs directly off the section. */
  unchanged: boolean;
  /** Where the node sat in the stack of the page, before anything moved. */
  order: number[];
};

/**
 * Moves nodes into a section, leaving each one where it is on the canvas.
 *
 * Only its own page supplies a section's children, and the nodes it can take
 * are the ones Figma lets out of where they are: not the section itself, not
 * anything holding it, not a layer of an instance, and not a variant, which
 * belongs to its set. A node already hanging off the section is reported and
 * left alone rather than re-stacked, so a second call changes nothing.
 *
 * The moved nodes land on top of what the section already holds, in the order
 * the page drew them, so nodes that overlap keep overlapping the same way.
 * @param req - The extension request.
 * @returns One result per node, and the section's box afterwards.
 */
const moveToSection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "move_to_section";
  const sectionId = readRequiredString(req.params, "sectionId", tool);
  const fit = readOptionalBoolean(req.params, "fit", tool) ?? false;
  if (!fit && req.params.padding !== undefined && req.params.padding !== null) {
    throw new Error(
      `${tool} takes padding only with fit: true, because padding is the margin the fit leaves around the children. Drop padding, or pass fit: true.`
    );
  }
  const padding = readOptionalNumber(req.params, "padding", tool, 0) ?? DEFAULT_PADDING;
  // The node IDs travel in the request's own `nodeIds` field, as they do for
  // the core tools that take a list of nodes, not among the params.
  const rawNodeIds = readBatchArray({ nodeIds: req.nodeIds }, "nodeIds", tool);

  const section = await readSectionById(sectionId, tool, "sectionId");
  const sectionPage = pageOf(section);
  if (sectionPage) await sectionPage.loadAsync();
  // A node holding the section would end up inside itself, and only a page or
  // another section holds one, so the whole chain above it is off limits.
  const holdingTheSection = ancestorIdsOf(section);

  const problems: string[] = [];
  const plans: MovePlan[] = [];
  const seen = new Set<string>();

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
    if (node.id === section.id) {
      fail(
        `${rawNodeId} is the section named by sectionId, and nothing holds itself. Leave it out of nodeIds, or name another section as sectionId.`
      );
      continue;
    }
    if (holdingTheSection.has(node.id)) {
      fail(
        `${rawNodeId} "${node.name}" is the ${node.type} that holds ${section.id} "${section.name}", so moving it in would put the section inside itself. Call move_out_of_section on the section first, or name a section outside ${rawNodeId}.`
      );
      continue;
    }
    const instance = instanceAncestorOf(node);
    if (instance) {
      fail(
        `${rawNodeId} "${node.name}" is a layer of the instance ${instance.id} "${instance.name}", and Figma lets no layer leave an instance. Move the instance itself, or call detach_instance on it first.`
      );
      continue;
    }
    if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") {
      fail(
        `${rawNodeId} "${node.name}" is a variant of the component set ${node.parent.id} "${node.parent.name}", and a variant only ever sits in its set. Pass ${node.parent.id} instead to move the whole set.`
      );
      continue;
    }
    const page = pageOf(node);
    if (page === null || sectionPage === null || page.id !== sectionPage.id) {
      fail(
        `${rawNodeId} "${node.name}" is on ${page ? `the page "${page.name}"` : "no page"}, while ${section.id} "${section.name}" is on ${sectionPage ? `"${sectionPage.name}"` : "no page"}. A section holds only nodes of its own page: move the node across first, or name a section on its page.`
      );
      continue;
    }

    plans.push({
      node,
      unchanged: node.parent !== null && node.parent.id === section.id,
      order: documentOrderKeyOf(node),
    });
  }

  if (problems.length > 0) throw validationError(tool, problems);

  // A fit with nothing to measure is refused here rather than after the moves,
  // so a call that cannot finish writes nothing at all. Every node keeps its
  // own visibility across a move, which makes this exact.
  const moving = plans.filter((plan) => !plan.unchanged);
  if (
    fit &&
    !section.children.some((child) => child.visible) &&
    !moving.some((p) => p.node.visible)
  )
    throw new Error(
      `${tool} wrote nothing. fit: true sizes the section to the children it holds, and none would be visible: ${section.id} "${section.name}" would hold ${section.children.length + moving.length} children, all of them hidden. Drop fit, or show a child with set_node_visibility.`
    );

  // The moved nodes go on top in the order the page drew them, which is only
  // defined across the page, since they need not share a parent. Each insert
  // lands the node among the ones already placed, so the group ends up in that
  // order however the caller listed them.
  const inStackOrder = [...moving].sort((a, b) => compareDocumentOrder(a.order, b.order));
  const rankOf = new Map<string, number>();
  inStackOrder.forEach((plan, rank) => rankOf.set(plan.node.id, rank));
  const placed = new Array<boolean>(inStackOrder.length).fill(false);
  let placedCount = 0;

  const { results } = await runBatchWrites(plans, async (plan) => {
    if (plan.unchanged) return { nodeId: plan.node.id, unchanged: true };
    const rank = rankOf.get(plan.node.id) ?? 0;
    let below = 0;
    for (let lower = 0; lower < rank; lower++) if (placed[lower]) below++;
    moveKeepingCanvasPosition(plan.node, section, section.children.length - placedCount + below);
    placed[rank] = true;
    placedCount++;
    return { nodeId: plan.node.id };
  });

  // A batch that stopped leaves the section holding half the move, and a fit
  // would then draw the box around that half. The results say what landed.
  if (fit && results.every((entry) => entry.ok)) {
    try {
      fitSectionToContents(section, padding, tool);
    } catch (err) {
      throw new Error(
        `${tool} moved ${plans.length === 1 ? "the node" : `all ${plans.length} nodes`} into ${section.id} "${section.name}", but could not then fit the section around them: ${messageOf(err)} Call fit_section on ${section.id} to finish.`
      );
    }
  }

  // Read last, because a fit slides every child, so the position a node holds
  // the moment it lands is not the position it ends the call at.
  for (const entry of results) {
    if (!entry.ok) continue;
    entry.x = plans[entry.index].node.x;
    entry.y = plans[entry.index].node.y;
  }

  return { results, section: describeSectionBox(section) };
};

/** One checked node on its way out of the section that holds it. */
type ExitPlan = {
  node: SceneNode;
  section: SectionNode;
  /** What holds the section: the page, or the section around it. */
  destination: SectionParent;
  /** Where the node sat inside its section, before anything moved. */
  stackIndex: number;
};

/**
 * Lifts nodes out of the sections holding them, one level.
 *
 * A section's parent is the only place its children can go without leaving the
 * shape of the page behind, so each node rises to it: the page, or the section
 * around it. Each node also lands directly above the section it left, which is
 * where the eye expects it, and the nodes of one section keep the order they
 * had inside it.
 *
 * Nodes from several sections travel in one call, each to its own
 * destination, so the insert position is read afresh per node rather than
 * cached: the sections below one already moved have shifted by then.
 * @param req - The extension request.
 * @returns One result per node.
 */
const moveOutOfSection = async (req: ExtensionRequest): Promise<unknown> => {
  const tool = "move_out_of_section";
  // The node IDs travel in the request's own `nodeIds` field, as they do for
  // the core tools that take a list of nodes, not among the params.
  const rawNodeIds = readBatchArray({ nodeIds: req.nodeIds }, "nodeIds", tool);

  const problems: string[] = [];
  const plans: ExitPlan[] = [];
  const seen = new Set<string>();

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

    const section = node.parent;
    if (!section || section.type !== "SECTION") {
      fail(
        `${rawNodeId} "${node.name}" hangs off ${section ? `the ${section.type} ${section.id} "${section.name}"` : "nothing"}, not off a section, so there is no section to leave. ${tool} lifts a node out of the section holding it; call reparent_nodes to take a node out of a frame, a group, or a component.`
      );
      continue;
    }
    const destination = section.parent;
    if (!destination || (destination.type !== "PAGE" && destination.type !== "SECTION")) {
      fail(
        `${rawNodeId} "${node.name}" sits in the section ${section.id} "${section.name}", which hangs off ${destination ? `a ${destination.type}` : "nothing"}, so the node has nowhere to rise to. Read the page with get_document before calling it again.`
      );
      continue;
    }
    await loadIfPage(destination);

    plans.push({
      node,
      section,
      destination,
      stackIndex: section.children.findIndex((child) => child.id === node.id),
    });
  }

  if (problems.length > 0) throw validationError(tool, problems);

  // Within one section the nodes keep the order they had, so each is ranked
  // by where it sat and then inserted among the ones already lifted out of
  // that same section. Sections are ranked apart, since each group lands above
  // its own section.
  const rankOf = new Map<string, number>();
  const placedPerSection = new Map<string, boolean[]>();
  const bySection = new Map<string, ExitPlan[]>();
  for (const plan of plans) {
    const group = bySection.get(plan.section.id);
    if (group) group.push(plan);
    else bySection.set(plan.section.id, [plan]);
  }
  for (const [sectionId, group] of bySection) {
    [...group]
      .sort((a, b) => a.stackIndex - b.stackIndex)
      .forEach((plan, rank) => rankOf.set(plan.node.id, rank));
    placedPerSection.set(sectionId, new Array<boolean>(group.length).fill(false));
  }

  return await runBatchWrites(plans, async (plan) => {
    const placed = placedPerSection.get(plan.section.id) ?? [];
    const rank = rankOf.get(plan.node.id) ?? 0;
    let below = 0;
    for (let lower = 0; lower < rank; lower++) if (placed[lower]) below++;

    // The section it left is normally still where it was, and the nodes
    // already lifted sit right above it. A section that has itself moved out
    // in this same call is no longer here, and the node then goes on top.
    const found = plan.destination.children.findIndex((child) => child.id === plan.section.id);
    const at = found < 0 ? plan.destination.children.length : found + 1 + below;
    moveKeepingCanvasPosition(plan.node, plan.destination, at);
    placed[rank] = true;

    return {
      nodeId: plan.node.id,
      parentId: plan.destination.id,
      x: plan.node.x,
      y: plan.node.y,
    };
  });
};

export const sectionsHandlers = {
  list_sections: { edit: false, run: listSections },
  get_section: { edit: false, run: getSection },
  create_section: { edit: true, run: createSection },
  fit_section: { edit: true, run: fitSection },
  move_to_section: { edit: true, run: moveToSection },
  move_out_of_section: { edit: true, run: moveOutOfSection },
} satisfies Record<string, ExtensionHandler>;
