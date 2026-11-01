param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$rootKey = $projectRoot.Replace('\', '/').ToLowerInvariant()
$hasher = [Security.Cryptography.SHA256]::Create()
$instance = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($rootKey)))).Replace('-', '').ToLowerInvariant().Substring(0, 20)
$hasher.Dispose()
$launchMutex = New-Object Threading.Mutex($false, "Local\Orbital-$instance")
$lockAcquired = $false
function Test-LocalPort {
    param([int]$Port)
    $probeClient = New-Object Net.Sockets.TcpClient
    $probeWait = $null
    try {
        $probe = $probeClient.BeginConnect([Net.IPAddress]::Loopback, $Port, $null, $null)
        $probeWait = $probe.AsyncWaitHandle
        if (-not $probeWait.WaitOne(40)) { return $false }
        $probeClient.EndConnect($probe)
        return $probeClient.Connected
    } catch {
        return $false
    } finally {
        $probeClient.Close()
        if ($probeWait) { $probeWait.Close() }
    }
}
try {
    $lockAcquired = $launchMutex.WaitOne(15000)
    if (-not $lockAcquired) { throw 'Another ORBITAL launch is still in progress. Please try again.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) { throw 'Missing dist/index.html. Run npm run build first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'python_lib\rdkit'))) { throw 'Missing bundled RDKit dependencies (python_lib/rdkit).' }
    $candidates = @(
        (Join-Path $projectRoot 'runtime\python.exe'),
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
    )
    $pythonExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $pythonExe) { throw 'Python 3.12 runtime was not found. Restore the runtime folder.' }
    $logDirectory = Join-Path $projectRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $chosenPort = $null
    $existingService = $null
    foreach ($portNumber in 8765..8785) {
        if (-not (Test-LocalPort -Port $portNumber)) { continue }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$portNumber/api/health" -TimeoutSec 1
            if ($health.app -eq 'orbital-molecular-studio' -and $health.instance -eq $instance) {
                $chosenPort = $portNumber
                $existingService = $health
                break
            }
        } catch { }
    }
    if (-not $existingService) {
        foreach ($portNumber in 8765..8785) {
            $listener = $null
            try {
                $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $portNumber)
                $listener.Server.ExclusiveAddressUse = $true
                $listener.Start()
                $chosenPort = $portNumber
                break
            } catch { } finally { if ($listener) { $listener.Stop() } }
        }
        if (-not $chosenPort) { throw 'Ports 8765-8785 are occupied. Free a local port and retry.' }
        $serverFile = Join-Path $projectRoot 'server.py'
        $serverProcess = Start-Process -FilePath $pythonExe -ArgumentList @('-u', ('"' + $serverFile + '"'), '--port', $chosenPort) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'server.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log')
        $deadline = [DateTime]::UtcNow.AddSeconds(35)
        while ([DateTime]::UtcNow -lt $deadline) {
            $serverProcess.Refresh()
            if ($serverProcess.HasExited) { throw 'ORBITAL could not start. See logs/server-error.log.' }
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$chosenPort/api/health" -TimeoutSec 1
                if ($health.app -eq 'orbital-molecular-studio' -and $health.instance -eq $instance -and $health.pid -eq $serverProcess.Id) {
                    $existingService = $health
                    break
                }
            } catch { }
            Start-Sleep -Milliseconds 300
        }
        if (-not $existingService) { throw 'The local engine did not become ready. See logs/server-error.log.' }
    }
    @{ pid = $existingService.pid; port = $chosenPort; instance = $instance; app = 'orbital-molecular-studio' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logDirectory 'service.json') -Encoding UTF8
    $appUrl = "http://127.0.0.1:$chosenPort"
    Write-Host "ORBITAL is ready: $appUrl"
    if (-not $NoBrowser) { Start-Process $appUrl }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($lockAcquired) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
