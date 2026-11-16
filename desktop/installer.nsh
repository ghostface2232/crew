; electron-builder starts the app after installing by handing the new Start menu shortcut to Explorer, which can
; refuse a shortcut it has not indexed yet ("cannot find ...\Crew.lnk"), so the app did not start after an install
; or an update (--force-run). Start the executable instead.
!macro customInstall
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
