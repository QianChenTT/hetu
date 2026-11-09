// The caps on what plugins draw, with no schema, so the SDK can hold to them without zod in its bundle

export const MAX_NODES = 10_000
export const MAX_TREE_DEPTH = 32
export const MAX_NODE_TEXT = 4000
export const MAX_OPS = 100
// Trees one plugin keeps in the drawer: its view instances and, for the layout, its skeleton
export const MAX_SURFACES = 20
export const MAX_PAYLOAD = 4096
export const MAX_CHILDREN_OF_SPLIT = 8
export const MAX_OPTIONS = 200
// A frame's message either way, as plain data
export const MAX_FRAME_MESSAGE = 64 * 1024
