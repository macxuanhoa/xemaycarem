# Weekly disposable local restore. Does not connect to or change the production DB.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$log = Join-Path 'backups' 'scheduler.log'
New-Item -ItemType Directory -Force -Path 'backups' | Out-Null
Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') weekly restore starting" -Encoding UTF8
$ErrorActionPreference = 'Continue'
node scripts/backup-verify.mjs --if-due 2>&1 | ForEach-Object { Add-Content -LiteralPath $log -Value $_ -Encoding UTF8 }
$verifyExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') weekly local restore exit=$verifyExit; hosted platform restore is a separate check" -Encoding UTF8
exit $verifyExit
