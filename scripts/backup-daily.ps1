# Daily production backup wrapper for Windows Task Scheduler.
# Takes one complete backup set, then checks every checksum and decodes Storage images.
# Produces a verified, friendly ZIP archive with readable Vietnamese names for Google Drive.
# A separate weekly task replays the business dump into disposable PostgreSQL. Both
# steps are logged; the task exit code is 0 only when daily integrity checks succeed.
# a log file. Run manually any time:  powershell -File scripts\backup-daily.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$log = Join-Path 'backups' 'scheduler.log'
function Note([string]$m) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}
New-Item -ItemType Directory -Force -Path 'backups' | Out-Null

# `supabase db dump` runs pg_dump in a container, so Docker Desktop must be awake.
# An unattended task very often lands while Docker is closed, which is not a real error.
# The engine named pipe disappears with Docker Desktop, so `docker info` writes its
# complaint to stderr; under $ErrorActionPreference = 'Stop' that stderr becomes a
# terminating NativeCommandError and kills the run before Docker can be started. The
# probe therefore runs in its own scope with Continue and trusts only the exit code
# ($LASTEXITCODE set inside a function is local, so a missing binary can't look like a
# previous success).
function Test-DockerEngine {
  $ErrorActionPreference = 'Continue'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}
function Ensure-Docker {
  if (Test-DockerEngine) { return $true }
  $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path $exe)) { Note 'Docker Desktop is not installed at the expected path - cannot start it'; return $false }
  Note 'Docker engine not running, starting Docker Desktop...'
  Start-Process $exe -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 5
    if (Test-DockerEngine) { Note "Docker ready after $((($i + 1) * 5))s"; return $true }
  }
  Note 'Docker engine still not responding after 200s'
  return $false
}

# The linked CLI needs its stored access token; a headless task has no interactive login,
# so fail loudly and early instead of letting the dump hang on a prompt.
# (Join-Path in Windows PowerShell 5.1 accepts only one child segment.)
$linked = Join-Path 'supabase' (Join-Path '.temp' 'linked-project.json')
if (-not (Test-Path $linked)) {
  Note "ABORT: $linked missing - run: npx supabase link --project-ref <ref>"
  exit 2
}

if (-not (Ensure-Docker)) { Note 'ABORT: backup needs a running Docker engine'; exit 3 }

Note '=== backup run starting ==='
# node writes progress to stderr; with Stop that would surface as a fake NativeCommandError,
# so only the exit code is treated as the verdict here.
$ErrorActionPreference = 'Continue'
node scripts/backup-prod.mjs --prune 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
$backupExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Note "backup-prod exit=$backupExit"

if ($backupExit -ne 0) { Note 'SKIP daily integrity follow-up: backup or configured mirror failed'; exit $backupExit }

$ErrorActionPreference = 'Continue'
node scripts/backup-verify.mjs --integrity-only 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
$verifyExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Note "backup-verify exit=$verifyExit (0 = checksums and all image bytes verified)"

if ($verifyExit -ne 0) { exit $verifyExit }

Note '=== friendly ZIP export for Google Drive / offline storage ==='
$ErrorActionPreference = 'Continue'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-export.ps1 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
$exportExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Note "backup-export exit=$exportExit (0 = friendly ZIP created and verified with readable Vietnamese names)"
Note '=== backup run finished ==='
if ($exportExit -ne 0) { exit $exportExit }
