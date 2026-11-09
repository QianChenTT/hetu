// The views menu in the core layer, drawn by the drawer in fixed styles no theme reaches: the layout and the theme the
// human picks, every declared view with its plugin's name, running or not, starred as a favorite and shown or hidden,
// and the keys two plugins bind with the owner the human picked. Everything is text

export type MenuData = {
  layouts: { id: string, name: string }[]
  layout: string | null
  themes: { id: string, name: string }[]
  theme: string | null
  themeFallback: boolean
  views: { key: string, name: string, title: string, running: boolean, favorite: boolean, instance: string | null, shown: boolean }[]
  conflicts: { key: string, plugins: { id: string, name: string }[], owner: string | null }[]
}

export type MenuActions = {
  pickLayout(id: string | null): void
  pickTheme(id: string | null): void
  favorite(key: string, on: boolean): void
  show(instance: string): void
  hide(instance: string): void
  ownKey(key: string, plugin: string | null): void
}

function heading(text: string): HTMLElement {
  const made = document.createElement('h2')
  made.textContent = text
  return made
}

function choice(label: string, options: { id: string, name: string }[], none: string, picked: string | null, pick: (id: string | null) => void): HTMLElement {
  const row = document.createElement('label')
  row.className = 'menu-row'
  const text = document.createElement('span')
  text.textContent = label
  const select = document.createElement('select')
  for (const option of [{ id: '', name: none }, ...options]) {
    const made = document.createElement('option')
    made.value = option.id
    made.textContent = option.name
    made.selected = option.id === (picked ?? '')
    select.append(made)
  }
  select.addEventListener('change', event => {
    if (event.isTrusted) pick(select.value === '' ? null : select.value)
  })
  row.append(text, select)
  return row
}

function action(text: string, act: () => void): HTMLButtonElement {
  const made = document.createElement('button')
  made.type = 'button'
  made.textContent = text
  made.addEventListener('click', event => {
    if (event.isTrusted) act()
  })
  return made
}

export function drawMenu(body: HTMLElement, data: MenuData, actions: MenuActions): void {
  const parts: HTMLElement[] = [
    heading('Look'),
    choice('Layout', data.layouts, 'Plain', data.layout, actions.pickLayout),
    choice('Theme', data.themes, 'hetu', data.theme, actions.pickTheme),
  ]
  if (data.themeFallback) {
    const note = document.createElement('p')
    note.className = 'menu-note'
    note.textContent = 'This theme\'s editor colors are too close to read, so the editor keeps hetu\'s'
    parts.push(note)
  }
  parts.push(heading('Views'))
  if (data.views.length === 0) {
    const none = document.createElement('p')
    none.className = 'menu-note'
    none.textContent = 'No plugin declares a view'
    parts.push(none)
  }
  const list = document.createElement('ul')
  list.className = 'menu-views'
  for (const view of data.views) {
    const item = document.createElement('li')
    item.dataset.view = view.key
    const star = action(view.favorite ? '★' : '☆', () => actions.favorite(view.key, !view.favorite))
    star.className = 'menu-star'
    star.title = view.favorite ? 'A favorite, which gets room first' : 'Make it a favorite, which gets room first'
    const name = document.createElement('span')
    name.className = 'menu-name'
    name.textContent = `${view.name} · ${view.title}${view.running ? '' : ' (not running)'}`
    item.append(star, name)
    if (view.instance !== null && view.running) {
      const instance = view.instance
      item.append(view.shown ? action('Hide', () => actions.hide(instance)) : action('Show', () => actions.show(instance)))
    }
    list.append(item)
  }
  parts.push(list)
  if (data.conflicts.length > 0) {
    parts.push(heading('Keys two plugins want'))
    for (const conflict of data.conflicts) {
      parts.push(choice(conflict.key, conflict.plugins, 'Neither', conflict.owner, id => actions.ownKey(conflict.key, id)))
    }
  }
  body.replaceChildren(...parts)
}
