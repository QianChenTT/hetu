// The page draws itself anew on every answer and event, so the control that had focus is found again in what was
// drawn and focus and the caret go back to it. A keyboard user never starts again at the top and a link being typed
// keeps its place

// The part of a drawn control this needs, which the tests give without a DOM
export type Control = {
  tagName: string
  dataset: { key?: string }
  getAttribute(name: string): string | null
  textContent: string | null
  closest(selector: string): { className: string } | null
  labels?: ArrayLike<{ textContent: string | null }> | null
}

// The key it was drawn with, else its section, its tag and its name as a screen reader reads it
export function controlKey(control: Control): string {
  if (control.dataset.key !== undefined) return control.dataset.key
  const where = control.closest('section, details, .plugin, .limit')?.className ?? ''
  const name = control.getAttribute('aria-label') ?? control.labels?.[0]?.textContent ?? control.textContent ?? ''
  return `${where}|${control.tagName}|${name.trim()}`
}

// The nth control with the key among those drawn, null for none
export function sameControl<T extends Control>(controls: readonly T[], key: string, nth: number): T | null {
  return controls.filter(control => controlKey(control) === key)[nth] ?? null
}
