// What the frames' hosts and the images host share, which sessions.ts serves all of them from

// What a host answers for one request: the bytes, their type and the CSP they load under
export type Served = { bytes: Uint8Array, type: string, csp: string }

// A host main serves the editor session from, faked in the tests
export type ServedHost = { serve(url: string): Served | null | Promise<Served | null> }

// An icon or a note's image is one the editor page shows with an img element, where no script in it runs. An SVG opened
// as a document runs nothing either and loads nothing
export const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
