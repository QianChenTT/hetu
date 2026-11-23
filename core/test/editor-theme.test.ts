import { describe, expect, it } from 'vitest'
import { DEFAULT_LINK_COLOR, linkColor } from '../api/ui.ts'
import { themeStyle } from '../frontend/editor/theme.ts'

describe('a theme as the drawer sets it', () => {
  it('sets nothing for no theme', () => {
    expect(themeStyle(null)).toEqual({ variables: {}, editorFallback: false })
  })

  it('sets a variable for each token, the editor\'s colors among them', () => {
    expect(themeStyle({ tokens: { 'color-bg': '#101010', 'color-fg': '#f0f0f0', radius: '6px' } })).toEqual({
      variables: {
        '--hetu-color-bg': '#101010', '--hetu-color-fg': '#f0f0f0', '--hetu-radius': '6px',
        '--hetu-color-editor-fg': '#f0f0f0', '--hetu-color-editor-bg': '#101010', '--hetu-color-editor-link': '#f0f0f0',
      },
      editorFallback: false,
    })
  })

  it('draws the editor in hetu\'s colors when the theme\'s fall under 4.5 to 1, and says so', () => {
    expect(themeStyle({ tokens: { 'color-editor-fg': '#fefefe', 'color-editor-bg': '#ffffff', 'color-accent': '#ff0000' } })).toEqual({
      variables: {
        '--hetu-color-accent': '#ff0000', '--hetu-color-editor-fg': '#1f1f1f', '--hetu-color-editor-bg': '#ffffff', '--hetu-color-editor-link': DEFAULT_LINK_COLOR,
      },
      editorFallback: true,
    })
  })

  it('draws links in the accent while it keeps 4.5 to 1 on the editor, else hetu\'s link color, else the text color', () => {
    expect(linkColor({ 'color-accent': '#8ab4f8' }, { fg: '#e8e8e8', bg: '#101010' })).toBe('#8ab4f8')
    expect(linkColor({ 'color-accent': '#202020' }, { fg: '#e8e8e8', bg: '#101010' })).toBe('#e8e8e8')
    expect(linkColor({ 'color-accent': '#ffff00' }, { fg: '#1f1f1f', bg: '#ffffff' })).toBe(DEFAULT_LINK_COLOR)
    expect(linkColor({}, { fg: '#1f1f1f', bg: '#ffffff' })).toBe(DEFAULT_LINK_COLOR)
    expect(themeStyle({ tokens: { 'color-editor-bg': '#101010', 'color-editor-fg': '#e8e8e8', 'color-accent': '#8ab4f8' } }).variables['--hetu-color-editor-link']).toBe('#8ab4f8')
  })
})
