# Registers (or renews) the daily production backup task in Windows Task Scheduler.
# Safe to re-run: it replaces the same task instead of adding a second one. The task runs
# only while this user is signed in — the price of not storing the Windows password in
# Task Scheduler — and "StartWhenAvailable" makes up a missed run at the next logon, which
# is the realistic behaviour for a shop laptop that is closed at 21:30.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
#   ... -At '06:30'      to choose another time
# Requires an elevated PowerShell only if Windows refuses the task (the script says so).
param(
  [string]$TaskName = 'Carem CRM - daily production backup',
  [string]$At = '21:30'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'backup-daily.ps1'
if (-not (Test-Path $script)) { throw "missing $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $root

$hour, $minute = $At.Split(':')
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::new(2000, 1, 1, [int]$hour, [int]$minute, 0))

# StartWhenAvailable is what turns "laptop was off at 21:30" into "runs on next boot/logon".
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::FromHours(1)) -RestartCount 2 -RestartInterval ([TimeSpan]::FromMinutes(15))

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Chup ban sao luu production (Supabase + Storage), kiem chung ban do nap lai duoc, va cat theo 7 ngay/4 tuan/12 thang. Log: backups\scheduler.log' `
    -Force | Out-Null
} catch {
  Write-Host "Khong the tao lich tu dong: $($_.Exception.Message)"
  Write-Host 'Mở PowerShell nhap "Run as administrator" roi chay lai file nay.'
  exit 1
}

$info = Get-ScheduledTask -TaskName $TaskName
Write-Host "Da gan lich: '$TaskName' ($($info.State)) chay hang ngay luc $At, bu khi mo may."
Write-Host "Kiểm tra nhanh:  schtasks /Run /TN `"$TaskName`"   roi mo backups\scheduler.log"
Write-Host "Xem suc khoe:    npm run backup:status"
