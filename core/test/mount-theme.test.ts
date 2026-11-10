import { describe, expect, it } from 'vitest'
import { themeStyle } from '../frontend/mount/theme.ts'

describe('a theme as the drawer sets it', () => {
  it('sets nothing for no theme', () => {
    expect(themeStyle(null)).toEqual({ variables: {}, editorFallback: false })
  })

  it('sets a variable for each token, the editor\'s colors among them', () => {
    expect(themeStyle({ tokens: { 'color-bg': '#101010', 'color-fg': '#f0f0f0', radius: '6px' } })).toEqual({
      variables: {
        '--hetu-color-bg': '#101010', '--hetu-color-fg': '#f0f0f0', '--hetu-radius': '6px',
        '--hetu-color-editor-fg': '#f0f0f0', '--hetu-color-editor-bg': '#101010',
      },
      editorFallback: false,
    })
  })

  it('draws the editor in hetu\'s colors when the theme\'s fall under 4.5 to 1, and says so', () => {
    expect(themeStyle({ tokens: { 'color-editor-fg': '#fefefe', 'color-editor-bg': '#ffffff', 'color-accent': '#ff0000' } })).toEqual({
      variables: { '--hetu-color-accent': '#ff0000', '--hetu-color-editor-fg': '#1f1f1f', '--hetu-color-editor-bg': '#ffffff' },
      editorFallback: true,
    })
  })
})
