# Read by electron-builder's assisted NSIS setup and its uninstaller before their own scripts. hetu installs for the
# current Windows account only, into %LOCALAPPDATA%\Programs\hetu, and neither one ever asks for administrator rights

!include LogicLib.nsh
!include nsDialogs.nsh
# Included here first, so the templates' own includes of it are empty and its elevating macros can be replaced below
!include UAC.nsh

# ERROR_ELEVATION_REQUIRED, the exit code of a setup or uninstaller that stopped where administrator rights were asked for
!define HETU_EXIT_ELEVATION_REFUSED 740

!macro hetuRefuseElevation
  MessageBox MB_OK|MB_ICONSTOP "hetu installs for this Windows account only and never asks for administrator rights" /SD IDOK
  SetErrorLevel ${HETU_EXIT_ELEVATION_REFUSED}
  Quit
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

!macro customInit
  !insertmacro hetuLockToCurrentUser
!macroend

!macro customUnInit
  !insertmacro hetuLockToCurrentUser
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
  ${IfNot} ${isUpdated}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}
!macroend
