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

function Read-EnvFile {
  param(
    [string]$Path
  )

  $values = @{}

  if (-not (Test-Path $Path)) {
    return $values
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()

    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $separatorIndex = $line.IndexOf("=")
    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1).Trim().Trim('"').Trim("'")

    if ($key) {
      $values[$key] = $value
    }
  }

  return $values
}

function Get-EnvValue {
  param(
    [hashtable]$Values,
    [string]$Name,
    [string]$Default = ""
  )

  if ($Values.ContainsKey($Name) -and $Values[$Name]) {
    return $Values[$Name]
  }

  return $Default
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

  return Get-EnvValue -Values $envValues -Name $Name -Default $Default
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

$envValues = @{}

foreach ($candidatePath in @($sharedEnvPath, $envPath)) {
  $candidateValues = Read-EnvFile -Path $candidatePath

  foreach ($entry in $candidateValues.GetEnumerator()) {
    $envValues[$entry.Key] = $entry.Value
  }
}
$terminalPath = Get-Setting -Name "MT5_TERMINAL_PATH"

if (-not $terminalPath) {
  throw "MT5_TERMINAL_PATH is missing from the active env configuration"
}

$terminalPath = [System.IO.Path]::GetFullPath($terminalPath)

if (-not (Test-Path $terminalPath)) {
  throw "Configured terminal path does not exist: $terminalPath"
}

$terminalDir = Split-Path -Parent $terminalPath
$portableEnabled = (Get-Setting -Name "MT5_PORTABLE").Trim().ToLower() -eq "true"
$login = Get-Setting -Name "MT5_LOGIN"
$password = Get-Setting -Name "MT5_PASSWORD"
$server = Get-Setting -Name "MT5_SERVER"
$useExplicitLogin = (Get-Setting -Name "MT5_STARTUP_USE_EXPLICIT_LOGIN" -Default "true").Trim().ToLower() -ne "false"
$startupSymbol = Get-Setting -Name "MT5_STARTUP_SYMBOL" -Default "EURUSD"
$startupPeriod = Get-Setting -Name "MT5_STARTUP_PERIOD" -Default "M1"
$bridgeRoot = Get-Setting -Name "MT5_NATIVE_BRIDGE_DIR"
$dataDir = Get-TerminalDataDir -TerminalPath $terminalPath -PortableEnabled $portableEnabled

if (-not $bridgeRoot) {
  if (-not $env:APPDATA) {
    throw "APPDATA is not available and MT5_NATIVE_BRIDGE_DIR is not set"
  }

  $bridgeRoot = Join-Path $env:APPDATA "MetaQuotes\\Terminal\\Common\\Files\\trading-bot-bridge"
}

$bridgeRoot = [System.IO.Path]::GetFullPath($bridgeRoot)
$heartbeatPath = Join-Path $bridgeRoot "status\\heartbeat.txt"
$terminalDir = Split-Path -Parent $terminalPath
$presetsDir = Join-Path $dataDir "MQL5\\Presets"
$presetPath = Join-Path $presetsDir "TradingBotBridgeEA.set"
$configPath = Join-Path $dataDir "bridge-start.ini"

$runningTerminal = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ([System.StringComparer]::OrdinalIgnoreCase.Equals($_.Path, $terminalPath))
} | Select-Object -First 1

if ($runningTerminal) {
  throw "The configured MT5 terminal is already running at $terminalPath. Close it first so the startup config can be applied."
}

New-Item -ItemType Directory -Force -Path $presetsDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $bridgeRoot "requests") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $bridgeRoot "responses") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $bridgeRoot "status") | Out-Null

if (Test-Path $heartbeatPath) {
  Remove-Item $heartbeatPath -Force
}

@(
  "; generated by bridge/start_mt5_native_bridge.ps1",
  "BridgeRoot=trading-bot-bridge",
  "PollIntervalMs=250"
) | Set-Content -Path $presetPath -Encoding ASCII

$configLines = New-Object System.Collections.Generic.List[string]

if ($useExplicitLogin) {
  $configLines.Add("[Common]")

  if ($login) {
    $configLines.Add("Login=$login")
  }

  if ($password) {
    $configLines.Add("Password=$password")
    $configLines.Add("KeepPrivate=1")
  }

  if ($server) {
    $configLines.Add("Server=$server")
  }
}

$configLines.Add("[Charts]")
$configLines.Add("ProfileLast=Default")
$configLines.Add("MaxBars=100000")
$configLines.Add("PrintColor=0")
$configLines.Add("SaveDeleted=0")
$configLines.Add("[Experts]")
$configLines.Add("AllowLiveTrading=1")
$configLines.Add("AllowDllImport=0")
$configLines.Add("Enabled=1")
$configLines.Add("Account=0")
$configLines.Add("Profile=0")
$configLines.Add("[StartUp]")
$configLines.Add("Expert=TradingBotBridgeEA")
$configLines.Add("ExpertParameters=TradingBotBridgeEA.set")
$configLines.Add("Symbol=$startupSymbol")
$configLines.Add("Period=$startupPeriod")

$configLines | Set-Content -Path $configPath -Encoding ASCII

$arguments = @()

if ($portableEnabled) {
  $arguments += "/portable"
}

$arguments += "/config:$configPath"

$launchTime = Get-Date
$process = Start-Process -FilePath $terminalPath -ArgumentList $arguments -PassThru
$deadline = (Get-Date).AddSeconds(90)

while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) {
    throw "MT5 exited before the bridge heartbeat appeared. Exit code: $($process.ExitCode)"
  }

  if (Test-Path $heartbeatPath) {
    $heartbeatFile = Get-Item $heartbeatPath

    if ($heartbeatFile.LastWriteTime -ge $launchTime.AddSeconds(-2)) {
      Write-Host "MT5 native bridge heartbeat detected."
      Write-Host "Terminal PID: $($process.Id)"
      Write-Host "Terminal path: $terminalPath"
      Write-Host "Startup config: $configPath"
      Write-Host "EA preset: $presetPath"
      Write-Host "Heartbeat: $heartbeatPath"
      exit 0
    }
  }

  Start-Sleep -Milliseconds 500
}

throw "Timed out waiting for the MT5 native bridge heartbeat at $heartbeatPath"
