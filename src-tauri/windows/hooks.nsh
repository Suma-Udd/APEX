; Runs inside the APEX installer and uninstaller.
; The backend can't be overwritten while it runs ("Error opening file for writing
; ...\apex-backend.exe"), so stop every copy of it first. Older APEX versions left
; it running after quitting or when starting an update.

!macro APEX_STOP_BACKEND
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM apex-backend.exe'
  Pop $0
  ; Give Windows a moment to release the file handles.
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro APEX_STOP_BACKEND
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro APEX_STOP_BACKEND
!macroend
