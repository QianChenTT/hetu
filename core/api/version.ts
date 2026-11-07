// The one version of the envelope. A message with another v is refused before any other field is read. Kept apart from
// zod, so the SDK loads it without the schemas
export const VERSION = 1
