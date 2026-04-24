const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { log } = require('./logger');

const repoRoot = path.join(__dirname, '..');
const runtimeDir = path.join(repoRoot, 'runtime');
const venvPython = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
const bridgeScript = path.join(repoRoot, 'bridge', 'mt5_bridge.py');
const installScript = path.join(repoRoot, 'bridge', 'install_mt5_native_bridge.ps1');
const startScript = path.join(repoRoot, 'bridge', 'start_mt5_native_bridge.ps1');
const bridgePidPath = path.join(runtimeDir, 'mt5-bridge.pid');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBridgeHealth() {
  const response = await fetch(`${String(config.mt5Bridge.baseUrl || '').replace(/\/+$/, '')}/health`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MT5 bridge health check failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function isBridgeHealthy() {
  try {
    await fetchBridgeHealth();
    return true;
  } catch (err) {
    return false;
  }
}

function spawnDetached(command, args, { stdoutPath, stderrPath }) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const stdoutFd = fs.openSync(stdoutPath, 'a');
  const stderrFd = fs.openSync(stderrPath, 'a');
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
  });

  child.unref();
  return child;
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

function readBridgePid() {
  try {
    const raw = fs.readFileSync(bridgePidPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    return null;
  }
}

async function waitForBridgeHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isBridgeHealthy()) {
      return true;
    }

    await delay(1000);
  }

  return false;
}

async function ensureHttpBridgeRunning() {
  if (!config.mt5Bridge.enabled || !config.mt5Bridge.autoStartHttpBridge) {
    return;
  }

  if (await isBridgeHealthy()) {
    log('MT5 HTTP bridge already healthy');
    return;
  }

  if (!fs.existsSync(venvPython)) {
    throw new Error(`MT5 auto-start expected Python at ${venvPython}`);
  }

  const existingPid = readBridgePid();

  if (isProcessAlive(existingPid)) {
    log(`Waiting for existing MT5 HTTP bridge process (pid ${existingPid})`);

    if (await waitForBridgeHealth(30000)) {
      log(`MT5 HTTP bridge became healthy (pid ${existingPid})`);
      return;
    }
  }

  log('Starting MT5 HTTP bridge automatically');
  const child = spawnDetached(venvPython, [bridgeScript], {
    stdoutPath: path.join(runtimeDir, 'mt5-bridge.out.log'),
    stderrPath: path.join(runtimeDir, 'mt5-bridge.err.log'),
  });

  fs.writeFileSync(path.join(runtimeDir, 'mt5-bridge.pid'), String(child.pid));

  if (await waitForBridgeHealth(30000)) {
    log(`MT5 HTTP bridge started automatically (pid ${child.pid})`);
    return;
  }

  throw new Error('Timed out waiting for MT5 HTTP bridge to become healthy');
}

function runPowerShellScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`PowerShell script failed (${path.basename(scriptPath)}): ${stderr || stdout || `exit code ${code}`}`));
    });
  });
}

async function ensureTerminalRunning() {
  if (!config.mt5Bridge.enabled || !config.mt5Bridge.autoStartTerminal) {
    return;
  }

  try {
    const health = await fetchBridgeHealth();

    if (health && health.status === 'ok' && health.connected === true) {
      log('MT5 terminal bridge heartbeat already healthy');
      return;
    }
  } catch (err) {
    // continue into startup flow
  }

  log('Installing MT5 bridge EA automatically');
  await runPowerShellScript(installScript);

  log('Launching MT5 terminal automatically with TradingBotBridgeEA');
  try {
    await runPowerShellScript(startScript);
  } catch (err) {
    if (String(err.message || '').includes('terminal is already running')) {
      log('MT5 terminal is already running; skipping automatic relaunch');
      return;
    }

    throw err;
  }
}

async function ensureMt5RuntimeReady() {
  if (!config.mt5Bridge.enabled) {
    return;
  }

  await ensureHttpBridgeRunning();
  await ensureTerminalRunning();
}

module.exports = {
  ensureMt5RuntimeReady,
};
