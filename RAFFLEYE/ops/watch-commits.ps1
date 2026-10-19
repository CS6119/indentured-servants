$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
$mutex = [System.Threading.Mutex]::new($false, 'Local\RAFFLEYE-Watcher')
if (-not $mutex.WaitOne(0)) { exit 0 }
$failedCommit = ''
$unhealthy = 0
try {
    while (-not (Test-Path -LiteralPath '.deploy/stop-watcher')) {
        try {
            $head = (& git rev-parse HEAD).Trim()
            $active = if (Test-Path -LiteralPath '.deploy/active.json') { Get-Content -LiteralPath '.deploy/active.json' -Raw | ConvertFrom-Json } else { $null }
            if ($head -ne $active.commit -and $head -ne $failedCommit) {
                & (Join-Path $PSScriptRoot 'deploy.ps1') -Ref $head
                $failedCommit = ''; $unhealthy = 0
            } elseif ($active) {
                & node.exe (Join-Path $active.release 'dist/cli.js') health | Out-Null
                if ($LASTEXITCODE -ne 0) { $unhealthy++ } else { $unhealthy = 0 }
                if ($unhealthy -ge 5) { & (Join-Path $PSScriptRoot 'deploy.ps1') -Ref $active.commit -Restart; $unhealthy = 0 }
            }
        } catch { $failedCommit = $head; Write-Warning ('Deployment needs attention: ' + $_.Exception.Message) }
        Start-Sleep -Seconds 15
    }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
