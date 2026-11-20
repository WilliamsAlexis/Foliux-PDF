; Limpieza al desinstalar Foliux PDF (se incluye automáticamente en el instalador).
;
; El desinstalador de electron-builder ya borra los archivos del programa, los accesos directos, las asociaciones de
; archivos .pdf y las claves del registro. Aquí se añade lo que deja atrás:
;   - el instalador que el actualizador automático descargó (carpeta de caché en %LOCALAPPDATA%)
;   - los datos del usuario, SOLO si él lo pide (se pregunta; con --delete-app-data se borran sin preguntar)
; Al ACTUALIZAR (el instalador nuevo desinstala el viejo) no se borra nada: se conservan los datos y la caché.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Electron y el actualizador usan carpetas del usuario aunque el programa esté instalado para todos
    ; (con «todos los usuarios», NSIS apunta $LOCALAPPDATA y $APPDATA a ProgramData si no se cambia el contexto).
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    ; Instalador descargado por el actualizador
    RMDir /r "$LOCALAPPDATA\@foliux-pdfdesktop-updater"

    ; ¿Borrar también los datos del usuario?
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${ifNot} ${Errors}
      Goto foliuxDeleteData
    ${endIf}
    ${if} ${Silent}
      Goto foliuxKeepData
    ${endIf}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "¿Quieres eliminar también tus datos de Foliux PDF?$\r$\n$\r$\nIncluye los ajustes, los archivos recientes, los espacios de trabajo, las firmas guardadas, las claves de IA cifradas y el registro de auditoría. Tus archivos PDF no se tocan.$\r$\n$\r$\nSi vas a reinstalar el programa, pulsa No para conservarlos." IDNO foliuxKeepData

    foliuxDeleteData:
    RMDir /r "$APPDATA\@foliux-pdf"

    foliuxKeepData:
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
