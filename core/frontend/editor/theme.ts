import { editorColors, type ThemeSpec, themeVariables } from '../../api/ui.ts'

// A theme as the drawer sets it: a CSS variable per token on the base layer and the editor, never on the core layer.
// The editor's text keeps 4.5 to 1 against its background whatever the theme says, else both fall back to hetu's
export function themeStyle(spec: ThemeSpec | null): { variables: Record<string, string>, editorFallback: boolean } {
  if (spec === null) return { variables: {}, editorFallback: false }
  const variables = themeVariables(spec.tokens)
  const editor = editorColors(spec.tokens)
  variables['--hetu-color-editor-fg'] = editor.fg
  variables['--hetu-color-editor-bg'] = editor.bg
  return { variables, editorFallback: !editor.ok }
}
