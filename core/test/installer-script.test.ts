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
      const lock = body.includes('!insertmacro hetuLockToCurrentUser') ? bodyOf(all, 'hetuLockToCurrentUser') : body
      expect(lock).toMatch(/\$\{isForAllUsers\}[\s\S]*\$\{UAC_IsInnerInstance\}[\s\S]*!insertmacro hetuRefuseElevation/)
      expect(lock).toMatch(/StrCpy\s+\$hasPerMachineInstallation\s+"0"/)
      expect(lock).toMatch(/!insertmacro setInstallModePerUser/)
    })
  }

  for (const refusal of ['hetuRefuseElevation', 'hetuRefuseFolder']) {
    it(`refuses with ERROR_ELEVATION_REQUIRED and quits, in ${refusal}`, async () => {
      const text = await readFile(script, 'utf8')
      const body = bodyOf(macros(text), refusal)
      expect(code(text)).toMatch(/!define\s+HETU_EXIT_REFUSED\s+740\b/)
      expect(body).toMatch(/SetErrorLevel\s+\$\{HETU_EXIT_REFUSED\}/)
      expect(body).toMatch(/^\s*Quit\s*$/m)
    })
  }

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
    expect(body).toMatch(/\$\{If\}\s+\$hetuDesktopBoxState\s+==\s+\$\{BST_CHECKED\}\s+CreateShortCut\s+"\$newDesktopLink"/)
    expect(body).toMatch(/\$\{ElseIf\}\s+\$hetuDesktopBoxState\s+==\s+\$\{BST_UNCHECKED\}[\s\S]*Delete\s+"\$newDesktopLink"/)
  })

  it('keeps the desktop shortcut through an update and removes it on an uninstall', async () => {
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customUnInstall')
    expect(body).toMatch(/\$\{IfNot\}\s+\$\{isUpdated\}[\s\S]*Delete\s+"\$newDesktopLink"[\s\S]*\$\{EndIf\}/)
  })
})

// The places the templates set $INSTDIR, read from the templates, then where the include sets it back
describe('the include script\'s lock to one install folder', () => {
  const read = (...parts: string[]) => readFile(path.join(templates, ...parts), 'utf8')
  // The code lines of a template, numbered from 1, comments blanked so the numbers hold
  const lines = async (...parts: string[]) => (await read(...parts)).split(/\r?\n/).map(line => (/^\s*[#;]/.test(line) ? '' : line))
  const at = (all: string[], pattern: RegExp) => all.findIndex(line => pattern.test(line))

  it('is %LOCALAPPDATA%\\Programs\\hetu, set by one macro', async () => {
    const text = await readFile(script, 'utf8')
    expect(code(text)).toMatch(/^!define\s+HETU_INSTALL_DIR\s+"\$LOCALAPPDATA\\Programs\\hetu"\s*$/m)
    expect(bodyOf(macros(text), 'hetuForceInstallDir').trim()).toBe('StrCpy $INSTDIR "${HETU_INSTALL_DIR}"')
  })

  // A template that set the folder somewhere new would slip past the include
  it('knows every place the templates set $INSTDIR', async () => {
    const sets: string[] = []
    for (const file of await templateFiles(templates)) {
      for (const macro of macros(await readFile(file, 'utf8'))) {
        if (/StrCpy\s+\$INSTDIR\b/.test(macro.body)) sets.push(macro.name)
      }
    }
    expect(sets.sort()).toEqual(['setInstallModePerAllUsers', 'setInstallModePerUser'])
    // The folder page's fix-up, compiled only with allowToChangeInstallationDirectory, which the setup leaves off
    const assisted = await lines('assistedInstaller.nsh')
    const fixup = at(assisted, /StrCpy \$INSTDIR "\$INSTDIR\\\$\{APP_FILENAME\}"/)
    expect(fixup).toBeGreaterThan(-1)
    expect(assisted.slice(0, fixup).some(line => /!ifdef allowToChangeInstallationDirectory/.test(line))).toBe(true)
  })

  it('sets it in the setup after .onInit picked it, which is where a silent run takes it from', async () => {
    const installer = await lines('installer.nsi')
    expect(at(installer, /!insertmacro initMultiUser/)).toBeLessThan(at(installer, /!insertmacro customInit/))
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customInit')
    expect(body.indexOf('!insertmacro hetuForceInstallDir')).toBeGreaterThan(body.indexOf('!insertmacro hetuLockToCurrentUser'))
  })

  // The install mode page's pre function calls setInstallModePerUser again, after .onInit
  it('sets it again in the progress page\'s pre function, after the install mode page', async () => {
    const assisted = await lines('assistedInstaller.nsh')
    const mode = at(assisted, /!insertmacro PAGE_INSTALL_MODE/)
    const hook = at(assisted, /!insertmacro customPageAfterChangeDir/)
    const progress = at(assisted, /!insertmacro MUI_PAGE_INSTFILES/)
    expect(mode).toBeGreaterThan(-1)
    expect(mode).toBeLessThan(hook)
    expect(hook).toBeLessThan(progress)
    // No MUI page between the hook and the progress page takes the pre function first
    expect(assisted.slice(hook + 1, progress).filter(line => /!insertmacro MUI_PAGE_|MUI_PAGE_CUSTOMFUNCTION/.test(line))).toEqual([])
    const all = macros(await readFile(script, 'utf8'))
    const page = bodyOf(all, 'customPageAfterChangeDir')
    const pre = /!define\s+MUI_PAGE_CUSTOMFUNCTION_PRE\s+(\S+)\s*$/.exec(page.trim())?.[1]
    expect(pre).toBeDefined()
    expect(page).toMatch(new RegExp(`Function\\s+${pre}\\s+!insertmacro hetuForceInstallDir\\s+FunctionEnd`))
  })

  it('refuses an uninstaller started for any other folder, read from $OUTDIR before the templates change $INSTDIR', async () => {
    const uninstaller = await lines('uninstaller.nsh')
    const start = at(uninstaller, /^Function un\.onInit/)
    const first = uninstaller.slice(start + 1).find(line => line.trim() !== '')
    expect(first?.trim()).toBe('SetOutPath $INSTDIR')
    const hook = at(uninstaller, /!insertmacro customUnInit/)
    expect(uninstaller.slice(start + 2, hook).filter(line => /SetOutPath/.test(line))).toEqual([])
    // Nothing the uninstaller's .onInit runs before the hook moves $OUTDIR
    const between = macros(await read('multiUser.nsh')).filter(macro => macro.name === 'setInstallModePerUser' || macro.name === 'setInstallModePerAllUsers')
    for (const macro of between) expect(macro.body, macro.name).not.toMatch(/SetOutPath/)
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customUnInit')
    expect(body).toMatch(/^\s*StrCpy\s+\$R9\s+\$OUTDIR\s*\n\s*!insertmacro hetuLockToCurrentUser\s*\n\s*!insertmacro hetuForceInstallDir\s*\n\s*\$\{If\}\s+\$R9\s+!=\s+\$INSTDIR\s*\n\s*!insertmacro hetuRefuseFolder/)
  })

  // The uninstall mode page's pre function sets it again after un.onInit
  it('sets it again inside the uninstall section, before anything is removed', async () => {
    const uninstaller = await lines('uninstaller.nsh')
    const hook = at(uninstaller, /!insertmacro customUnInstall\b/)
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(at(uninstaller, /RMDir \/r \$INSTDIR/))
    expect(hook).toBeLessThan(at(uninstaller, /!insertmacro customRemoveFiles/))
    const body = bodyOf(macros(await readFile(script, 'utf8')), 'customUnInstall')
    expect(code(body).trim().split('\n')[0]!.trim()).toBe('!insertmacro hetuForceInstallDir')
  })
})
