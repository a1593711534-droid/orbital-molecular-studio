$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $PSScriptRoot 'logs\service.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Host 'No recorded ORBITAL service.'; exit 0 }
try {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.port)/api/health" -TimeoutSec 2
    if ($health.app -ne 'orbital-molecular-studio' -or $health.instance -ne $state.instance -or $health.pid -ne $state.pid) {
        throw 'Service identity did not match. No process was stopped.'
    }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)"
    $expectedServer = Join-Path $PSScriptRoot 'server.py'
    if (-not $processInfo -or -not $processInfo.CommandLine.Contains($expectedServer)) {
        throw 'Process path did not match. No process was stopped.'
    }
    Stop-Process -Id $state.pid
    Remove-Item -LiteralPath $stateFile
    Write-Host 'ORBITAL stopped.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    exit 1
}
