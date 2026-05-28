// hv core — shared constants. No DOM, no app state.

export const SVG_NS = "http://www.w3.org/2000/svg";

// Cap on the number of draggable node-edit handles mounted at once (a guard so
// the node tool stays responsive on huge traced paths).
export const MAX_HANDLES = 1500;

// SVG container/metadata tags that are never treated as editable artwork.
export const SKIP_TAGS = new Set(["defs", "style", "title", "metadata", "desc"]);

// Primitive shape tools (drag-to-create on the canvas).
export const SHAPE_TOOLS = new Set(["rect", "ellipse", "line"]);
