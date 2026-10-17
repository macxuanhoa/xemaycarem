# Prepare a complete, verified ZIP with human-readable Vietnamese names for the OWNER's Google Drive / offline backup.
# Preserves 100% original data byte-for-byte with full SHA-256 verification.
# Contains customer information and password hashes; store only in secure private storage.
param(
  [string]$Stamp,
  [switch]$NoOffsiteCopy,
  [switch]$KeepStaging
)
$ErrorActionPreference = 'Stop'

Set-Location (Split-Path -Parent $PSScriptRoot)
$backupRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'backups'))

# Auto-detect latest backup if not specified
if (-not $Stamp) {
  $healthFile = Join-Path $backupRoot 'LATEST.json'
  if (Test-Path -LiteralPath $healthFile) {
    try {
      $health = Get-Content -LiteralPath $healthFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $Stamp = $health.lastBackup.stamp
    } catch {}
  }
}
if (-not $Stamp) {
  $latestManifest = Get-ChildItem -LiteralPath $backupRoot -Filter 'carem-prod-*-MANIFEST.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latestManifest) {
    if ($latestManifest.Name -match '^carem-prod-(\d{4}-?\d{2}-?\d{2}-\d{6})-MANIFEST\.md$') {
      $Stamp = $Matches[1]
    }
  }
}

if ($Stamp -notmatch '^\d{4}-?\d{2}-?\d{2}-\d{6}$') { throw "Invalid or missing backup stamp: '$Stamp'" }

$prefix = "carem-prod-$Stamp"
$manifest = Join-Path $backupRoot "$prefix-MANIFEST.md"
if (-not (Test-Path -LiteralPath $manifest)) { throw "Complete manifest is required for export: $manifest" }

Write-Host "Kiem tra tinh toan ven ban sao luu goc $Stamp..."
$ErrorActionPreference = 'Continue'
node scripts/backup-verify.mjs --integrity-only --set $Stamp
$verifyExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($verifyExit -ne 0) { throw 'Ban sao luu goc khong dat kiem tra checksum; tu choi xuat ZIP' }

Write-Host "Chuan bi danh muc va dat ten de doc cho cac tep..."
# KHONG duoc bat stdout cua node vao bien: PowerShell 5.1 giai ma stdout theo bang
# ma console, nen ten thu muc co dau tieng Viet bi vo hoa va Test-Path that bai.
# node ghi ban ke hoach ra file UTF-8; doc file do bang -Encoding UTF8.
$ErrorActionPreference = 'Continue'
node scripts/backup-export-prepare.mjs $Stamp | Out-Null
$prepExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$planFile = Join-Path $backupRoot "export-plan-$Stamp.json"
if ($prepExit -ne 0 -or -not (Test-Path -LiteralPath $planFile)) {
  throw "Loi khi chuan bi cau truc tep de doc (exit=$prepExit, ke hoach=$planFile)"
}
$prep = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json
$exportName = $prep.ExportName
$stagePath = $prep.StagePath
$expectedPath = $prep.ExpectedPath

if (-not (Test-Path -LiteralPath $stagePath)) { throw "Thu muc dan dung khong ton tai: $stagePath" }
if (-not (Test-Path -LiteralPath $expectedPath)) { throw "Tep kiem tra du kien khong ton tai: $expectedPath" }

$destination = [IO.Path]::GetFullPath((Join-Path $backupRoot $exportName))
if (-not $destination.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Duong dan tep ZIP vuot ra ngoai thu muc backups'
}

# Remove existing zip if present
if (Test-Path -LiteralPath $destination) {
  Remove-Item -LiteralPath $destination -Force
}

Write-Host "Dang dong goi tep ZIP chuan UTF-8: $exportName..."
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagePath, $destination, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)

# Verify compressed ZIP entries byte-for-byte against expected hashes
Write-Host "Xac thuc tung tep ben trong tep ZIP voi ma bam SHA-256..."
$expectedJson = Get-Content -LiteralPath $expectedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedMap = @{}
foreach ($item in $expectedJson.files) {
  $normPath = $item.archivePath.Replace('\', '/')
  $expectedMap[$normPath] = $item.SHA256
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($destination)
$verified = 0
try {
  foreach ($entry in $archive.Entries) {
    $entryName = $entry.FullName.Replace('\', '/')
    if ($entryName.EndsWith('/')) { continue }
    if (-not $expectedMap.ContainsKey($entryName)) {
      throw "Tep khong mong doi trong archive: $entryName"
    }
    $stream = $entry.Open()
    $digest = [System.Security.Cryptography.SHA256]::Create()
    try {
      $payloadHash = [BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-', '').ToUpperInvariant()
      if ($payloadHash -ne $expectedMap[$entryName]) {
        throw "Sai lech ma kiem tra SHA-256 cua tep: $entryName"
      }
      $verified++
    } finally {
      $stream.Dispose()
      $digest.Dispose()
    }
  }
  if ($verified -ne $expectedMap.Count) {
    throw "So luong tep trong ZIP ($verified) khong khop voi so luong du kien ($($expectedMap.Count))"
  }
} finally {
  $archive.Dispose()
}

# Clean up staging preview directory unless requested to keep
if (-not $KeepStaging) {
  $stagingParent = Split-Path -Parent $stagePath
  if (Test-Path -LiteralPath $stagingParent) {
    Remove-Item -LiteralPath $stagingParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$zipHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToUpperInvariant()
$zipBytes = (Get-Item -LiteralPath $destination).Length

Write-Host "Da dong goi thanh cong $verified tep vao: $exportName ($([Math]::Round($zipBytes / 1MB, 2)) MB)"

# Check and copy to offsite Google Drive folder if configured
$offsiteCopied = $null
if (-not $NoOffsiteCopy) {
  $offsiteTxt = Join-Path $backupRoot 'offsite.txt'
  $offsiteDir = $null
  if (Test-Path -LiteralPath $offsiteTxt) {
    $line = Get-Content -LiteralPath $offsiteTxt | Where-Object { $_ -and -not $_.StartsWith('#') } | Select-Object -First 1
    if ($line) { $offsiteDir = $line.Trim() }
  }

  if ($offsiteDir -and (Test-Path -LiteralPath $offsiteDir)) {
    $markerFile = Join-Path $offsiteDir '.carem-backup-mirror'
    if (Test-Path -LiteralPath $markerFile) {
      $destOffsite = Join-Path $offsiteDir $exportName
      Write-Host "Sao chep tep ZIP sang thu muc Google Drive: $destOffsite..."
      Copy-Item -LiteralPath $destination -Destination $destOffsite -Force
      $offsiteHash = (Get-FileHash -LiteralPath $destOffsite -Algorithm SHA256).Hash.ToUpperInvariant()
      if ($offsiteHash -eq $zipHash) {
        $offsiteCopied = $destOffsite
        Write-Host "Da sao chep va xac thuc toan ven sang Google Drive thanh cong!"
      } else {
        Write-Warning "Sao chep sang Google Drive co ma bam khong khop!"
      }
    }
  }
}

# Update cloud-target.json record with the latest export info
$cloudTargetFile = Join-Path $backupRoot 'cloud-target.json'
if (Test-Path -LiteralPath $cloudTargetFile) {
  try {
    $ct = Get-Content -LiteralPath $cloudTargetFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $ct | Add-Member -NotePropertyName 'lastExport' -NotePropertyValue ([pscustomobject]@{
      stamp = $Stamp
      fileName = $exportName
      filePath = $destination
      bytes = $zipBytes
      sha256 = $zipHash
      verifiedEntries = $verified
      exportedAt = (Get-Date).ToString('o')
      offsiteCopied = $offsiteCopied
    }) -Force
    $jsonUtf8 = $ct | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($cloudTargetFile, $jsonUtf8, [System.Text.UTF8Encoding]::new($false))
  } catch {}
}

# Output result object
[pscustomobject]@{
  Path = $destination
  Stamp = $Stamp
  ExportName = $exportName
  Bytes = $zipBytes
  SHA256 = $zipHash
  VerifiedEntries = $verified
  OffsiteCopied = $offsiteCopied
  Sensitive = $true
  Uploaded = [bool]$offsiteCopied
} | ConvertTo-Json
