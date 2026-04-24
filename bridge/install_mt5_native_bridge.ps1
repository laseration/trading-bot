$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sharedEnvPath = Join-Path $repoRoot ".env.shared"
$legacyEnvPath = Join-Path $repoRoot ".env"
$envMode = [System.Environment]::GetEnvironmentVariable("TRADING_ENV", "Process")

if (-not $envMode) {
  $envMode = [System.Environment]::GetEnvironmentVariable("BOT_ENV", "Process")
}

$envMode = "$envMode".Trim().ToLower()
$envPath = if ($envMode) {
  Join-Path $repoRoot ".env.$envMode"
} else {
  $legacyEnvPath
}
$sourcePath = Join-Path $PSScriptRoot "mql5\\TradingBotBridgeEA.mq5"

if (-not (Test-Path $sourcePath)) {
  throw "MT5 bridge source not found at $sourcePath"
}

$envValues = @{}

foreach ($candidatePath in @($sharedEnvPath, $envPath)) {
  if (-not (Test-Path $candidatePath)) {
    continue
  }

  Get-Content $candidatePath | ForEach-Object {
    $line = $_.Trim()

    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $separatorIndex = $line.IndexOf("=")
    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1).Trim().Trim('"').Trim("'")

    if ($key) {
      $envValues[$key] = $value
    }
  }
}

function Get-Setting {
  param(
    [string]$Name,
    [string]$Default = ""
  )

  $processValue = [System.Environment]::GetEnvironmentVariable($Name, "Process")

  if ($processValue) {
    return $processValue
  }

  if ($envValues.ContainsKey($Name) -and $envValues[$Name]) {
    return $envValues[$Name]
  }

  return $Default
}

function Get-TerminalDataDir {
  param(
    [string]$TerminalPath,
    [bool]$PortableEnabled
  )

  $terminalDir = Split-Path -Parent $TerminalPath

  if ($PortableEnabled) {
    return $terminalDir
  }

  if (-not $env:APPDATA) {
    throw "APPDATA is not available for resolving the MT5 data directory"
  }

  $metaQuotesRoot = Join-Path $env:APPDATA "MetaQuotes\\Terminal"

  if (-not (Test-Path $metaQuotesRoot)) {
    throw "MetaQuotes terminal data root was not found at $metaQuotesRoot"
  }

  $normalizedTerminalPath = [System.IO.Path]::GetFullPath($TerminalPath)
  $originFiles = Get-ChildItem -Path $metaQuotesRoot -Recurse -Filter origin.txt -ErrorAction SilentlyContinue

  foreach ($originFile in $originFiles) {
    try {
      $originText = [System.IO.File]::ReadAllText($originFile.FullName).Trim([char]0xFEFF, [char]0x0000, [char]0x0020, [char]0x000D, [char]0x000A, [char]0x0009)
    } catch {
      continue
    }

    if (-not $originText) {
      continue
    }

    $originPath = [System.IO.Path]::GetFullPath($originText)

    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($originPath, $normalizedTerminalPath) -or [System.StringComparer]::OrdinalIgnoreCase.Equals($originPath, $terminalDir)) {
      return $originFile.Directory.FullName
    }
  }

  throw "Could not resolve the MT5 data directory for $TerminalPath"
}

$terminalPath = Get-Setting "MT5_TERMINAL_PATH"

if (-not $terminalPath) {
  throw "MT5_TERMINAL_PATH is missing from the active env configuration"
}

$terminalPath = [System.IO.Path]::GetFullPath($terminalPath)

if (-not (Test-Path $terminalPath)) {
  throw "Configured terminal path does not exist: $terminalPath"
}

$portableValue = Get-Setting "MT5_PORTABLE"
$portableEnabled = ($portableValue.Trim().ToLower() -eq "true")
$dataDir = Get-TerminalDataDir -TerminalPath $terminalPath -PortableEnabled $portableEnabled
$terminalDir = Split-Path -Parent $terminalPath
$metaEditorPath = Join-Path $terminalDir "MetaEditor64.exe"
$expertsDir = Join-Path $dataDir "MQL5\\Experts"
$destinationPath = Join-Path $expertsDir "TradingBotBridgeEA.mq5"
$compileLogPath = Join-Path $dataDir "bridge-compile.log"

if (-not (Test-Path $metaEditorPath)) {
  throw "MetaEditor64.exe was not found next to terminal64.exe"
}

New-Item -ItemType Directory -Force -Path $expertsDir | Out-Null
Copy-Item $sourcePath $destinationPath -Force
$arguments = @()

if ($portableEnabled) {
  $arguments += "/portable"
}

$arguments += "/compile:$destinationPath"
$arguments += "/log:$compileLogPath"

$compileProcess = Start-Process -FilePath $metaEditorPath -ArgumentList $arguments -Wait -PassThru

Write-Host "MT5 bridge source copied to: $destinationPath"
Write-Host "MT5 data directory: $dataDir"
Write-Host "Compile log: $compileLogPath"
Write-Host "MetaEditor exit code: $($compileProcess.ExitCode)"

if (Test-Path $compileLogPath) {
  $compileLog = Get-Content $compileLogPath
  $compileLog

  $resultLine = $compileLog | Where-Object { $_ -match '^Result:\s+\d+\s+errors,\s+\d+\s+warnings' } | Select-Object -Last 1

  if ($resultLine -and $resultLine -match '^Result:\s+(\d+)\s+errors,\s+(\d+)\s+warnings') {
    $errorCount = [int]$Matches[1]

    if ($errorCount -gt 0) {
      throw "MetaEditor reported compile errors. See $compileLogPath"
    }
  }
}
