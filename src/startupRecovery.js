const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');
const { log } = require('./logger');

const repoRoot = path.join(__dirname, '..');
const runtimeDir = path.join(repoRoot, 'runtime');
const botLockPath = path.join(runtimeDir, 'bot.lock.json');
const bridgeLockPath = path.join(runtimeDir, 'mt5-bridge.lock.json');
const bridgePidPath = path.join(runtimeDir, 'mt5-bridge.pid');
const bridgeScriptPath = path.join(repoRoot, 'bridge', 'mt5_bridge.py');
const repoVenvPath = path.join(repoRoot, '.venv');

function normalizeText(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function readPidFile(filePath) {
  try {
    const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    return null;
  }
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    return false;
  }
}

function getProcessInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    const command = [
      '$p = Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"',
      'if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }',
    ].join('; ');
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      command,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    }).trim();

    return output ? JSON.parse(output) : null;
  } catch (err) {
    return null;
  }
}

function commandContainsProcess(info, needle) {
  const commandLine = normalizeText(info && info.CommandLine);
  const executablePath = normalizeText(info && info.ExecutablePath);
  const normalizedNeedle = normalizeText(needle);
  return commandLine.includes(normalizedNeedle) || executablePath.includes(normalizedNeedle);
}

function isRepoBotProcess(info) {
  if (!info) {
    return false;
  }

  return commandContainsProcess(info, repoRoot)
    && commandContainsProcess(info, path.join('src', 'index.js'));
}

function looksLikeBotProcess(info) {
  return commandContainsProcess(info, path.join('src', 'index.js'))
    || /npm(\.cmd)?\s+run\s+start/i.test(String(info && info.CommandLine || ''));
}

function isRepoBridgeProcess(info) {
  if (!info) {
    return false;
  }

  return commandContainsProcess(info, bridgeScriptPath)
    || (
      commandContainsProcess(info, path.join('bridge', 'mt5_bridge.py'))
      && (commandContainsProcess(info, repoVenvPath) || commandContainsProcess(info, path.join('.venv', 'Scripts', 'python.exe')))
    );
}

function looksLikeBridgeProcess(info) {
  return commandContainsProcess(info, path.join('bridge', 'mt5_bridge.py'))
    || commandContainsProcess(info, 'mt5_bridge.py');
}

function terminateProcess(pid, label) {
  process.kill(pid);
  log(`Startup cleanup: ${label} process ${pid} terminated`);
}

function describeProcess(info) {
  if (!info) {
    return 'process not found';
  }

  return `${info.Name || 'process'} pid=${info.ProcessId} command=${info.CommandLine || info.ExecutablePath || 'unknown'}`;
}

function cleanLockFile({ label, filePath, terminate, isOwnedProcess }) {
  if (!fs.existsSync(filePath)) {
    return { action: 'missing' };
  }

  const lock = readJsonFile(filePath);
  const pid = Number(lock && lock.pid);

  if (!Number.isInteger(pid) || pid <= 0) {
    if (config.startup.cleanStaleLocks) {
      removeFile(filePath);
      log(`Startup cleanup: stale ${label} lock removed (${filePath}, invalid pid)`);
      return { action: 'removed_invalid' };
    }

    throw new Error(`Startup cleanup refused invalid ${label} lock at ${filePath}; STARTUP_CLEAN_STALE_LOCKS=false`);
  }

  const info = getProcessInfo(pid);

  if (!info || !isProcessAlive(pid)) {
    if (config.startup.cleanStaleLocks) {
      removeFile(filePath);
      log(`Startup cleanup: stale ${label} lock removed (${filePath}, pid ${pid} is not running)`);
      return { action: 'removed_stale', pid };
    }

    throw new Error(`Startup cleanup found stale ${label} lock for dead pid ${pid}; STARTUP_CLEAN_STALE_LOCKS=false`);
  }

  const looksRelevant = label === 'bot' ? looksLikeBotProcess(info) : looksLikeBridgeProcess(info);

  if (!isOwnedProcess(info)) {
    if (looksRelevant) {
      throw new Error(`Startup cleanup found live ${label} lock for a relevant process that is not safely owned by this repo: ${describeProcess(info)}`);
    }

    if (config.startup.cleanStaleLocks) {
      removeFile(filePath);
      log(`Startup cleanup: stale ${label} lock removed (${filePath}, pid ${pid} belongs to unrelated process: ${describeProcess(info)})`);
      return { action: 'removed_stale_reused_pid', pid };
    }

    throw new Error(`Startup cleanup found stale ${label} lock with reused pid ${pid}; STARTUP_CLEAN_STALE_LOCKS=false`);
  }

  log(`Startup cleanup: existing ${label} process found (${describeProcess(info)})`);

  if (terminate) {
    terminateProcess(pid, label);
    removeFile(filePath);
    return { action: 'terminated', pid };
  }

  if (label === 'bot') {
    throw new Error(`Startup cleanup refused to start: existing bot process is running (pid ${pid}). Set STARTUP_TERMINATE_OLD_BOT=true to terminate repo-owned old bot processes.`);
  }

  return { action: 'kept_alive', pid };
}

function cleanPidFile({ label, filePath, terminate, isOwnedProcess }) {
  if (!fs.existsSync(filePath)) {
    return { action: 'missing' };
  }

  const pid = readPidFile(filePath);

  if (!pid) {
    if (config.startup.cleanStaleLocks) {
      removeFile(filePath);
      log(`Startup cleanup: stale ${label} pid file removed (${filePath}, invalid pid)`);
      return { action: 'removed_invalid' };
    }

    throw new Error(`Startup cleanup refused invalid ${label} pid file at ${filePath}; STARTUP_CLEAN_STALE_LOCKS=false`);
  }

  const info = getProcessInfo(pid);

  if (!info || !isProcessAlive(pid)) {
    if (config.startup.cleanStaleLocks) {
      removeFile(filePath);
      log(`Startup cleanup: stale ${label} pid file removed (${filePath}, pid ${pid} is not running)`);
      return { action: 'removed_stale', pid };
    }

    throw new Error(`Startup cleanup found stale ${label} pid file for dead pid ${pid}; STARTUP_CLEAN_STALE_LOCKS=false`);
  }

  const looksRelevant = label === 'bot' ? looksLikeBotProcess(info) : looksLikeBridgeProcess(info);

  if (!isOwnedProcess(info)) {
    if (looksRelevant) {
      throw new Error(`Startup cleanup found live ${label} pid ${pid}, but it is not safely owned by this repo: ${describeProcess(info)}`);
    }

    if (config.startup.cleanStaleLocks) {
      removeFile(filePath);
      log(`Startup cleanup: stale ${label} pid file removed (${filePath}, pid ${pid} belongs to unrelated process: ${describeProcess(info)})`);
      return { action: 'removed_stale_reused_pid', pid };
    }

    throw new Error(`Startup cleanup found stale ${label} pid file with reused pid ${pid}; STARTUP_CLEAN_STALE_LOCKS=false`);
  }

  log(`Startup cleanup: existing ${label} pid file points to ${describeProcess(info)}`);

  if (terminate) {
    terminateProcess(pid, label);
    removeFile(filePath);
    return { action: 'terminated', pid };
  }

  return { action: 'kept_alive', pid };
}

function runStartupCleanup() {
  fs.mkdirSync(runtimeDir, { recursive: true });

  const results = [
    cleanLockFile({
      label: 'bot',
      filePath: botLockPath,
      terminate: config.startup.terminateOldBot,
      isOwnedProcess: isRepoBotProcess,
    }),
    cleanLockFile({
      label: 'MT5 bridge',
      filePath: bridgeLockPath,
      terminate: config.startup.terminateOldBridge,
      isOwnedProcess: isRepoBridgeProcess,
    }),
    cleanPidFile({
      label: 'MT5 bridge',
      filePath: bridgePidPath,
      terminate: config.startup.terminateOldBridge,
      isOwnedProcess: isRepoBridgeProcess,
    }),
  ];

  if (results.every((result) => result.action === 'missing' || result.action === 'kept_alive')) {
    log('Startup cleanup: no stale locks found');
  }
}

function readStartupState() {
  const botLock = readJsonFile(botLockPath);
  const bridgeLock = readJsonFile(bridgeLockPath);
  const bridgePid = readPidFile(bridgePidPath);

  return {
    paths: {
      botLockPath,
      bridgeLockPath,
      bridgePidPath,
    },
    botLock,
    botProcess: botLock && botLock.pid ? getProcessInfo(Number(botLock.pid)) : null,
    bridgeLock,
    bridgeLockProcess: bridgeLock && bridgeLock.pid ? getProcessInfo(Number(bridgeLock.pid)) : null,
    bridgePid,
    bridgePidProcess: bridgePid ? getProcessInfo(bridgePid) : null,
  };
}

module.exports = {
  botLockPath,
  bridgeLockPath,
  bridgePidPath,
  getProcessInfo,
  isProcessAlive,
  readStartupState,
  runStartupCleanup,
};
