param([string]$Ref = 'HEAD', [switch]$Restart)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
$deployRoot = Join-Path $project '.deploy'
New-Item -ItemType Directory -Force -Path $deployRoot | Out-Null
$mutex = [System.Threading.Mutex]::new($false, 'Local\RAFFLEYE-Deploy')
if (-not $mutex.WaitOne(0)) { throw 'Another deployment is in progress.' }
function Run-Npm([string[]]$Arguments) {
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed" }
}
function Stop-Bot {
    $metadataPath = Join-Path $project 'data/typescript-process.json'
    if (-not (Test-Path -LiteralPath $metadataPath)) { return }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($metadata.pid)"
    if (-not $process) { return }
    if ($process.Name -ne 'node.exe' -or $process.CommandLine -notlike "*$project*cli.js*bot*") { throw 'Refusing to stop a process that is not this RAFFLEYE bot.' }
    New-Item -ItemType File -Force -Path (Join-Path $project "data/stop-$($metadata.pid)") | Out-Null
    $deadline = (Get-Date).AddSeconds(65)
    while ((Get-Process -Id $metadata.pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
    if (Get-Process -Id $metadata.pid -ErrorAction SilentlyContinue) { throw 'Bot did not stop gracefully; deployment aborted.' }
}
function Start-Release([string]$Release) {
    $entry = Join-Path $Release 'dist/cli.js'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $started = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"' + $entry + '"'), 'bot') -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $project "data/ts-$stamp.stdout.log") -RedirectStandardError (Join-Path $project "data/ts-$stamp.stderr.log")
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if ($started.HasExited) { throw 'New bot exited before becoming healthy.' }
        $health = & node.exe $entry health 2>$null | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $health.healthy -and $health.pid -eq $started.Id) { return }
    }
    throw 'New bot did not become healthy.'
}
try {
    $commit = (& git rev-parse --verify "$Ref^{commit}").Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Invalid release commit.' }
    $activePath = Join-Path $deployRoot 'active.json'
    $old = if (Test-Path -LiteralPath $activePath) { Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json } else { $null }
    if ($old -and $old.commit -eq $commit -and -not $Restart) { Write-Output 'Release already active.'; return }
    $release = Join-Path $deployRoot "releases/$commit"
    if (-not (Test-Path -LiteralPath (Join-Path $release 'validated'))) {
        New-Item -ItemType Directory -Force -Path $release | Out-Null
        $archive = Join-Path $deployRoot "$commit.zip"
        & git archive --format=zip --output=$archive $commit
        if ($LASTEXITCODE -ne 0) { throw 'Could not archive committed source.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $release -Force
        Push-Location -LiteralPath $release
        try { Run-Npm -Arguments @('ci'); Run-Npm -Arguments @('run','validate'); New-Item -ItemType File -Path 'validated' -Force | Out-Null } finally { Pop-Location }
    }
    $legacy = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'raffleye\.cli\s+bot' }
    if ($legacy) { throw 'Stop the verified legacy Python bot before the first TypeScript deployment.' }
    Stop-Bot
    $entry = Join-Path $release 'dist/cli.js'
    $backup = Join-Path $project ('data/backups/pre-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sqlite3')
    try {
        & node.exe $entry backup $backup
        if ($LASTEXITCODE -ne 0) { throw 'Database backup failed; deployment stopped.' }
        Start-Release $release
        @{ commit=$commit; release=$release; deployed_at=(Get-Date).ToUniversalTime().ToString('o'); previous=$old.release } | ConvertTo-Json | Set-Content -LiteralPath $activePath
        Write-Output "Healthy TypeScript release: $($commit.Substring(0,12))"
    } catch {
        Stop-Bot
        if ($old) { Start-Release $old.release; Write-Warning 'Previous code release restored; live data was retained.' }
        throw
    }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
