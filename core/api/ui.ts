import { z } from 'zod'

// What plugins draw in the editor window: themes as token values, trees of the drawer's building blocks and the ui
// verbs on a plugin's port to the drawer. Data, schemas and pure functions only, shared by the drawer and the SDK

// ---- themes

// A theme sets these and nothing else. The drawer puts each on the base layer and the editor as --hetu-<name>, never
// on the banner, the raw view, titles, owner strips or the views menu
const color = z.string().max(7).regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
// Family names only, unquoted, so no value can close the property or load a font from anywhere
const font = z.string().max(200).regex(/^[A-Za-z0-9 _-]{1,40}(?:, ?[A-Za-z0-9 _-]{1,40}){0,5}$/)
const pixels = (min: number, max: number) => z.string().max(4).regex(/^[0-9]{1,2}px$/)
  .refine(value => Number.parseInt(value, 10) >= min && Number.parseInt(value, 10) <= max, `${min} to ${max}px`)

const tokenShapes = {
  'color-bg': color,
  'color-fg': color,
  'color-muted': color,
  'color-accent': color,
  'color-border': color,
  'color-surface': color,
  'color-editor-bg': color,
  'color-editor-fg': color,
  'color-selection': color,
  'font-ui': font,
  'font-editor': font,
  'font-mono': font,
  'font-size': pixels(10, 24),
  space: pixels(0, 32),
  radius: pixels(0, 16),
}
export type TokenName = keyof typeof tokenShapes
export const tokenNames = Object.freeze(Object.keys(tokenShapes) as TokenName[])

export const themeSpec = z.strictObject({
  tokens: z.strictObject(Object.fromEntries(Object.entries(tokenShapes).map(([name, shape]) => [name, shape.optional()])) as {
    [K in TokenName]: z.ZodOptional<typeof tokenShapes[K]>
  }),
})
export type ThemeSpec = z.infer<typeof themeSpec>
