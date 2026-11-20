# Prueba de instalación y desinstalación del instalador generado (Windows, solo para el usuario actual).
#
# Uso (tras `npm run dist`):   powershell -ExecutionPolicy Bypass -File scripts\test-uninstaller.ps1
#
# Instala en una carpeta temporal y comprueba que al desinstalar desaparecen la carpeta del programa, los accesos
# directos, las claves del registro y el instalador que descargó el actualizador; que los datos del usuario se
# conservan salvo con --delete-app-data; y que al ACTUALIZAR (--updated) no se borra nada.
# Los datos reales del usuario (%APPDATA%\@foliux-pdf) se APARTAN (se renombran) durante la prueba y se restauran al final.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$setup = Get-ChildItem (Join-Path $root 'apps\desktop\dist') -Filter 'Foliux-PDF-Setup-*.exe' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'No hay instalador: ejecuta primero npm run dist' }

$inst = Join-Path $env:TEMP 'foliux-install-test'
$cache = "$env:LOCALAPPDATA\@foliux-pdfdesktop-updater"
$data = "$env:APPDATA\@foliux-pdf"
$backup = "$env:APPDATA\@foliux-pdf.BACKUP-TEST"
$failures = 0

function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "  OK   $name" } else { Write-Host "  FALLA $name" -ForegroundColor Red; $script:failures++ }
}

function Cycle([string[]]$uninstallArgs) {
  Remove-Item $inst -Recurse -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $setup.FullName -ArgumentList '/S', '/currentuser', "/D=$inst" -Wait | Out-Null
  New-Item -ItemType Directory -Force $cache | Out-Null
  Set-Content "$cache\installer.exe" 'descargado por el actualizador'
  New-Item -ItemType Directory -Force "$data\desktop" | Out-Null
  Set-Content "$data\desktop\settings.json" '{}'
  Start-Sleep 2
  Start-Process -FilePath "$inst\Uninstall Foliux PDF.exe" -ArgumentList $uninstallArgs -Wait | Out-Null
  for ($i = 0; $i -lt 60; $i++) { if (-not (Test-Path $inst)) { break }; Start-Sleep 1 }
  Start-Sleep 3
}

$hadData = Test-Path $data
try {
  if ($hadData) { Rename-Item $data $backup }

  Write-Host '== Desinstalación normal (silenciosa)'
  Cycle @('/currentuser', '/S')
  Check 'carpeta del programa eliminada' (-not (Test-Path $inst))
  Check 'instalador descargado por el actualizador eliminado' (-not (Test-Path $cache))
  Check 'datos del usuario conservados' (Test-Path "$data\desktop\settings.json")
  Check 'acceso directo del menú Inicio eliminado' (-not (Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Foliux PDF.lnk"))
  Check 'acceso directo del escritorio eliminado' (-not (Test-Path "$([Environment]::GetFolderPath('Desktop'))\Foliux PDF.lnk"))
  $key = reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall' /s /f 'Foliux' 2>&1 | Select-String 'DisplayName'
  Check 'clave de desinstalación del registro eliminada' (-not $key)

  Write-Host '== Con --delete-app-data (borra también los datos)'
  Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
  Cycle @('/currentuser', '/S', '--delete-app-data')
  Check 'carpeta del programa eliminada' (-not (Test-Path $inst))
  Check 'datos del usuario eliminados' (-not (Test-Path $data))

  Write-Host '== Al ACTUALIZAR (--updated) no se borran los datos ni la caché'
  Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
  Cycle @('/currentuser', '/S', '--updated')
  Check 'datos del usuario conservados' (Test-Path "$data\desktop\settings.json")
  Check 'caché del actualizador conservada' (Test-Path "$cache\installer.exe")
}
finally {
  Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
  if ($hadData -and (Test-Path $backup)) { Rename-Item $backup $data }
  Remove-Item $inst -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $cache -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like '*Foliux*' } |
    ForEach-Object { Remove-Item $_.PSPath -Recurse -Force }
  Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Foliux PDF.lnk" -ErrorAction SilentlyContinue
  Remove-Item "$([Environment]::GetFolderPath('Desktop'))\Foliux PDF.lnk" -ErrorAction SilentlyContinue
}

if ($failures -gt 0) { Write-Host "$failures comprobaciones fallaron" -ForegroundColor Red; exit 1 }
Write-Host 'Todo correcto' -ForegroundColor Green
