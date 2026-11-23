import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The include script electron-builder puts before its assisted NSIS templates, read against the templates of the
// app-builder-lib in node_modules. The script runs only inside a built setup, which CI builds and installs
const script = path.join(import.meta.dirname, '..', 'build', 'installer.nsh')
const require = createRequire(import.meta.url)
const builder = path.dirname(require.resolve('electron-builder/package.json'))
const templates = path.join(path.dirname(createRequire(path.join(builder, 'package.json')).resolve('app-builder-lib/package.json')), 'templates', 'nsis')

// NSIS text with its comments gone: /* */ blocks and lines starting with # or ;
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(line => !/^\s*[#;]/.test(line)).join('\n')
}

// Each !macro's name and body, a name defined twice keeping both
function macros(text: string): { name: string, body: string }[] {
  return [...code(text).matchAll(/^\s*!macro\s+(\S+)[^\n]*\n([\s\S]*?)^\s*!macroend/gm)].map(match => ({ name: match[1]!, body: match[2]! }))
}

const bodyOf = (all: { name: string, body: string }[], name: string): string => {
  const found = all.filter(macro => macro.name === name)
  expect(found, name).toHaveLength(1)
  return found[0]!.body
}

async function templateFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(nsh|nsi)$/.test(entry.name)) files.push(path.join(entry.parentPath, entry.name))
  }
  return files
}

// UAC's plugin call that starts an elevated copy of the running setup
const ELEVATE = /UAC::_\s+0\b/

describe('the include script\'s lock to the current user', () => {
  it('skips the install mode page by forcing the current user', async () => {
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customInstallMode')
    expect(body).toMatch(/StrCpy\s+\$isForceCurrentInstall\s+"1"/)
    expect(body).not.toMatch(/isForceMachineInstall/)
  })

  for (const hook of ['customInit', 'customUnInit']) {
    it(`refuses /allusers and an elevated inner copy, then sets the current user's mode, in ${hook}`, async () => {
      const all = macros(await readFile(script, 'utf8'))
      const body = bodyOf(all, hook)
      const lock = body.includes('!insertmacro hetuCurrentUserOnly') ? bodyOf(all, 'hetuCurrentUserOnly') : body
      expect(lock).toMatch(/\$\{isForAllUsers\}[\s\S]*\$\{UAC_IsInnerInstance\}[\s\S]*!insertmacro hetuRefuseElevation/)
      expect(lock).toMatch(/StrCpy\s+\$hasPerMachineInstallation\s+"0"/)
      expect(lock).toMatch(/!insertmacro setInstallModePerUser/)
    })
  }

  it('refuses with ERROR_ELEVATION_REQUIRED and quits', async () => {
    const text = await readFile(script, 'utf8')
    const body = bodyOf(macros(text), 'hetuRefuseElevation')
    expect(code(text)).toMatch(/!define\s+HETU_REFUSED_ELEVATION\s+740\b/)
    expect(body).toMatch(/SetErrorLevel\s+\$\{HETU_REFUSED_ELEVATION\}/)
    expect(body).toMatch(/^\s*Quit\s*$/m)
  })

  // A template that reached the plugin directly, or a new macro around it, would slip past the include
  it('replaces every macro the templates reach UAC\'s elevation through with the refusal', async () => {
    const uacPath = path.join(templates, 'include', 'UAC.nsh')
    const elevating = macros(await readFile(uacPath, 'utf8')).filter(macro => ELEVATE.test(macro.body)).map(macro => macro.name)
    expect(elevating.sort()).toEqual(['UAC_PageElevation_RunElevated', 'UAC_RunElevated'])
    for (const file of await templateFiles(templates)) {
      if (file === uacPath) continue
      expect(code(await readFile(file, 'utf8')), path.relative(templates, file)).not.toMatch(ELEVATE)
    }
    const text = code(await readFile(script, 'utf8'))
    expect(text.indexOf('!include UAC.nsh')).toBeGreaterThanOrEqual(0)
    for (const name of elevating) {
      expect(text, name).toMatch(new RegExp(`^\\s*!macroundef\\s+${name}\\s*$`, 'm'))
      expect(text.indexOf(`!macroundef ${name}`)).toBeGreaterThan(text.indexOf('!include UAC.nsh'))
      const body = bodyOf(macros(text), name)
      expect(body.trim()).toBe('!insertmacro hetuRefuseElevation')
    }
  })

  it('reaches no elevation itself', async () => {
    expect(code(await readFile(script, 'utf8'))).not.toMatch(/UAC::|RequestExecutionLevel|ExecShell\s+"?runas/i)
  })
})

describe('the include script\'s pages and shortcut', () => {
  it('shows a welcome page and a desktop shortcut checkbox before the install', async () => {
    const all = macros(await readFile(script, 'utf8'))
    expect(bodyOf(all, 'customWelcomePage')).toMatch(/!insertmacro MUI_PAGE_WELCOME/)
    const page = bodyOf(all, 'customPageAfterChangeDir')
    expect(page).toMatch(/Page\s+custom\s+hetuDesktopPage\s+hetuDesktopLeave/)
    expect(page).toMatch(/\$\{NSD_CreateCheckbox\}/)
  })

  it('makes the desktop shortcut only when the box was ticked and removes it only when it was cleared', async () => {
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customInstall')
    expect(body).toMatch(/\$\{If\}\s+\$hetuDesktopWanted\s+==\s+\$\{BST_CHECKED\}\s+CreateShortCut\s+"\$newDesktopLink"/)
    expect(body).toMatch(/\$\{ElseIf\}\s+\$hetuDesktopWanted\s+==\s+\$\{BST_UNCHECKED\}[\s\S]*Delete\s+"\$newDesktopLink"/)
  })

  it('keeps the desktop shortcut through an update and removes it on an uninstall', async () => {
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customUnInstall')
    expect(body).toMatch(/\$\{IfNot\}\s+\$\{isUpdated\}[\s\S]*Delete\s+"\$newDesktopLink"[\s\S]*\$\{EndIf\}/)
  })
})
