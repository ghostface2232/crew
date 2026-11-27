; electron-builder starts the app after installing by handing the new Start menu shortcut to Explorer, which can
; refuse a shortcut it has not indexed yet ("cannot find ...\Crew.lnk"), so the app did not start after an install
; or an update (--force-run). Start the executable instead.
!macro customInstall
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

; The app's Open at Login entry (Electron's login item, named after the app's AppUserModelId) would otherwise point at
; a removed Crew.exe. An update runs the old uninstaller too, and keeps the entry, since Crew.exe stays where it was.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dev.crew.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "dev.crew.desktop"
  ${endIf}
!macroend
