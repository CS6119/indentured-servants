param([switch]$AtLogon)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
New-Item -ItemType Directory -Force -Path '.deploy' | Out-Null
if (Test-Path -LiteralPath '.deploy/stop-watcher') { throw 'Remove .deploy/stop-watcher when you are ready to resume automatic deployment.' }
$shell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$watcher = Join-Path $PSScriptRoot 'watch-commits.ps1'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $watcher + '"'
if ($AtLogon) {
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'RAFFLEYE watcher.lnk'))
    $shortcut.TargetPath = $shell
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $project
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$process = Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $project ".deploy/watcher-$stamp.stdout.log") -RedirectStandardError (Join-Path $project ".deploy/watcher-$stamp.stderr.log")
@{pid=$process.Id; started_at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath '.deploy/watcher-process.json'
Write-Output 'Commit watcher started in the background.'
