import { pageOf } from "../shared";
import { describeValue, readOptionalString } from "./batch";
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

/**
 * The absolute position of a section: the origin its children measure from.
 *
 * Read off `absoluteTransform` rather than `absoluteBoundingBox`, which is
 * nullable. A section does not rotate, so the two agree.
 * @param node - The section.
 * @returns Its absolute x and y.
 */
const absoluteOriginOf = (node: SectionNode): { x: number; y: number } => {
  const transform = node.absoluteTransform;
  return { x: transform[0][2], y: transform[1][2] };
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

export const sectionsHandlers = {
  list_sections: { edit: false, run: listSections },
  get_section: { edit: false, run: getSection },
} satisfies Record<string, ExtensionHandler>;
