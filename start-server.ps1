Param(
    [switch]$OpenBrowser
)

# Script para iniciar el servidor Node desde un acceso directo en Windows.
# Comportamiento:
# 1) Arranca `node server.js` en el directorio del proyecto.
# 2) Espera hasta `http://localhost:3000/status` (timeout configurable).
# 3) Muestra un mensaje indicando éxito o fallo y opcionalmente abre el navegador.

try {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} catch {
    $projectRoot = Get-Location
}

$serverScript = Join-Path $projectRoot 'server.js'
if (-not (Test-Path $serverScript)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("No se encontró server.js en: `n$projectRoot","Error arrancando servidor")
    exit 1
}

# Crear carpeta de logs si no existe
$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -Path $logDir -ItemType Directory -Force | Out-Null }

# Intentar iniciar Node en background (ventana minimizada)
try {
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $projectRoot -WindowStyle Minimized
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("No se pudo iniciar Node. Asegúrate de que 'node' está en el PATH.\nError: $_","Error")
    exit 1
}

# Poll a /status para verificar arranque
$statusUrl = 'http://localhost:3000/status'
$timeoutSec = 30
$elapsed = 0
Write-Output "Esperando que el servidor responda en $statusUrl (timeout ${timeoutSec}s)..."
while ($elapsed -lt $timeoutSec) {
    try {
        $r = Invoke-RestMethod -Uri $statusUrl -Method Get -TimeoutSec 3
        if ($r) { break }
    } catch { }
    Start-Sleep -Seconds 1
    $elapsed++
}

Add-Type -AssemblyName PresentationFramework
if ($elapsed -lt $timeoutSec) {
    [System.Windows.MessageBox]::Show("Servidor iniciado correctamente.\nAbrir UI en http://localhost:3000","Servidor iniciado")
    if ($OpenBrowser) { Start-Process 'http://localhost:3000' }
    exit 0
} else {
    [System.Windows.MessageBox]::Show("Timeout: no se pudo conectar a $statusUrl en ${timeoutSec}s. Revisa que no haya otro proceso usando el puerto o mira los logs.","Error al iniciar servidor")
    exit 2
}
