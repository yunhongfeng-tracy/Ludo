param(
  [Parameter(Mandatory=$true)][string]$Session,
  [Parameter(Mandatory=$true)][string]$Expression,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$browserReportCommand = (Get-Command npx.cmd -ErrorAction Stop).Source
$browserReportOutput = & $browserReportCommand --yes --package '@playwright/cli' playwright-cli "-s=$Session" eval $Expression
if ($LASTEXITCODE -ne 0) { throw 'Browser report retrieval failed.' }
$browserReportText = $browserReportOutput -join "`n"
if (!$browserReportText.Contains('### Result')) { throw $browserReportText }
$browserReportParts = ($browserReportText -split '### Result',2)[1] -split '### Ran Playwright code',2
$browserReportJson = $browserReportParts[0].Trim()
$browserReportData = $browserReportJson | ConvertFrom-Json
if (!$browserReportData -or $browserReportData.status -eq 'running') { throw 'Report is missing or still running.' }
if ($browserReportJson.Contains([string][char]0xFFFD)) { throw 'Report contains an encoding replacement character.' }
$browserReportTarget = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($browserReportTarget)) | Out-Null
[IO.File]::WriteAllText($browserReportTarget,$browserReportJson + "`n",[Text.UTF8Encoding]::new($false))
Write-Output $browserReportTarget
