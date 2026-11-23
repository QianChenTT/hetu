# Read by electron-builder's assisted NSIS setup and its uninstaller before their own scripts. hetu installs for the
# current Windows account only, into %LOCALAPPDATA%\Programs\hetu, and neither one ever asks for administrator rights

!include LogicLib.nsh
!include nsDialogs.nsh
# Included here first, so the templates' own includes of it are empty and its elevating macros can be replaced below
!include UAC.nsh

# The exit code of a setup or uninstaller that refused: where administrator rights were asked for, or an uninstaller
# started for a folder other than the one hetu installs to. 740 is ERROR_ELEVATION_REQUIRED
!define HETU_EXIT_REFUSED 740

# The one folder hetu installs to. The per user mode sets the shell folders to the current user's first
!define HETU_INSTALL_DIR "$LOCALAPPDATA\Programs\hetu"

!macro hetuRefuseElevation
  MessageBox MB_OK|MB_ICONSTOP "hetu installs for this Windows account only and never asks for administrator rights" /SD IDOK
  SetErrorLevel ${HETU_EXIT_REFUSED}
  Quit
!macroend

!macro hetuRefuseFolder
  MessageBox MB_OK|MB_ICONSTOP "This uninstaller removes hetu only from ${HETU_INSTALL_DIR}" /SD IDOK
  SetErrorLevel ${HETU_EXIT_REFUSED}
  Quit
!macroend

# The templates set $INSTDIR from /D=, an earlier install's InstallLocation in HKCU and the per user programs folder,
# which can be redirected. Each of those is overridden here
!macro hetuForceInstallDir
  StrCpy $INSTDIR "${HETU_INSTALL_DIR}"
!macroend

# The templates start an elevated copy of the setup or the uninstaller only through these two macros: for a per machine
# install found in the registry, for /allusers and for the all users choice of the install mode page. Each one refuses
# now, whatever the registry or the command line holds
!macroundef UAC_RunElevated
!macro UAC_RunElevated
  !insertmacro hetuRefuseElevation
!macroend

!macroundef UAC_PageElevation_RunElevated
!macro UAC_PageElevation_RunElevated
  !insertmacro hetuRefuseElevation
!macroend

# The install mode page asks just me or all users. Forcing the current user skips it
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

# Runs after the templates picked the mode from the registry and the command line. /allusers asks for the per machine
# mode and an inner instance is the elevated half of a UAC start, so both are refused. A per machine entry found in the
# registry no longer picks the mode
!macro hetuLockToCurrentUser
  ${If} ${isForAllUsers}
  ${OrIf} ${UAC_IsInnerInstance}
    !insertmacro hetuRefuseElevation
  ${EndIf}
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

# The last of the setup's .onInit, after initMultiUser set the folder. A silent run shows no page, so this is the folder
# it installs to
!macro customInit
  !insertmacro hetuLockToCurrentUser
  !insertmacro hetuForceInstallDir
!macroend

# un.onInit's first line made $OUTDIR the folder the uninstaller was started for, its own or the one _?= names, and
# nothing before this changes $OUTDIR. An uninstaller for any other folder refuses before it removes anything
!macro customUnInit
  StrCpy $R9 $OUTDIR
  !insertmacro hetuLockToCurrentUser
  !insertmacro hetuForceInstallDir
  ${If} $R9 != $INSTDIR
    !insertmacro hetuRefuseFolder
  ${EndIf}
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Install hetu"
  !define MUI_WELCOMEPAGE_TEXT "This installs hetu for your Windows account only. No administrator rights are needed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

# The desktop shortcut as a checkbox before the install, ticked when the shortcut is already there. electron-builder's
# hook for a page after the folder page, which this setup doesn't show, so it follows Welcome. The box's state is
# kept only when the page was shown, so a silent run or an update leaves the shortcut as it was
!macro customPageAfterChangeDir
  Var hetuDesktopBox
  Var hetuDesktopBoxState

  Page custom hetuDesktopPage hetuDesktopLeave

  Function hetuDesktopPage
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "hetu is added to the Start menu"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0u 0u 100% 12u "Create a desktop shortcut"
    Pop $hetuDesktopBox
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      ${NSD_Check} $hetuDesktopBox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function hetuDesktopLeave
    ${NSD_GetState} $hetuDesktopBox $hetuDesktopBoxState
  FunctionEnd

  # The install mode page's pre function sets the folder again after .onInit. The progress page is the next MUI page,
  # so this runs after it and right before the files go in
  Function hetuInstallDirBeforeFiles
    !insertmacro hetuForceInstallDir
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE hetuInstallDirBeforeFiles
!macroend

!macro customInstall
  ${If} $hetuDesktopBoxState == ${BST_CHECKED}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${ElseIf} $hetuDesktopBoxState == ${BST_UNCHECKED}
  ${AndIf} ${FileExists} "$newDesktopLink"
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

# An update runs the older uninstaller with --updated, which keeps the shortcut for the newer setup. A setup run with
# --delete-app-data passes that flag in its place, so the shortcut goes then
!macro customUnInstall
  # The uninstall mode page's pre function sets the folder again after un.onInit. This runs inside the uninstall section,
  # before anything is removed
  !insertmacro hetuForceInstallDir
  ${IfNot} ${isUpdated}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}
!macroend
