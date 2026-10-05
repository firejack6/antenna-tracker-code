param([int]$Port = 8765, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$dashboardPython = Join-Path $env:USERPROFILE '.platformio\penv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $dashboardPython)) {
    $dashboardPython = (Get-Command python -ErrorAction Stop).Source
}
$dashboardArgs = @((Join-Path $PSScriptRoot 'dashboard\relay.py'), '--port', "$Port")
if ($NoBrowser) { $dashboardArgs += '--no-browser' }
& $dashboardPython @dashboardArgs
exit $LASTEXITCODE
