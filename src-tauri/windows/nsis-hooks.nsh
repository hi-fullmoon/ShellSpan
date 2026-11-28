!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\shellspan" "" "URL:ShellSpan Protocol"
  WriteRegStr HKCU "Software\Classes\shellspan" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\shellspan\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\shellspan\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\AppUserModelId\com.shellspan" "DisplayName" "ShellSpan"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\com.shellspan" "IconBackgroundColor" "0"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\shellspan"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.shellspan"
!macroend
