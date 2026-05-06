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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.mt5Bridge.timeoutMs);

  let response;

  try {
    response = await fetch(`${String(config.mt5Bridge.baseUrl || '').replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`request timeout/abort after ${config.mt5Bridge.timeoutMs}ms`);
    }

    throw new Error(`HTTP bridge unreachable: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP bridge alive but health returned ${response.status}: ${body || 'empty response'}`);
  }

  return response.json();
}

function describeBridgeHealthError(err) {
  const message = String(err && err.message || err || 'unknown error');

  if (/timeout|abort/i.test(message)) {
    return `request timeout/abort: ${message}`;
  }

  if (/unreachable|ECONNREFUSED|fetch failed|Unable to connect/i.test(message)) {
    return `HTTP bridge unreachable: ${message}`;
  }

  if (/connected.*false|terminal disconnected/i.test(message)) {
    return `HTTP bridge alive but MT5 terminal disconnected: ${message}`;
  }

  if (/health returned/i.test(message)) {
    return message;
  }

  return message;
}

async function fetchBridgeHealthWithRetries(options = {}) {
  const retries = Math.max(1, Number(options.retries || config.startup.bridgeHealthRetries || 3));
  const delayMs = Math.max(0, Number(options.delayMs || config.startup.bridgeHealthRetryDelayMs || 2000));
  const label = options.label || 'MT5 bridge health';
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const health = await fetchBridgeHealth();

      if (options.requireConnected && health.connected !== true) {
        throw new Error(`terminal disconnected (connected=${health.connected})`);
      }

      log(`${label} attempt ${attempt}/${retries} ok`);
      return health;
    } catch (err) {
      lastError = err;
      log(`${label} attempt ${attempt}/${retries} failed: ${describeBridgeHealthError(err)}`);

      if (attempt < retries) {
        await delay(delayMs);
      }
    }
  }

  throw new Error(`${label} failed after ${retries} attempt(s): ${describeBridgeHealthError(lastError)}`);
}

async function isBridgeHealthy() {
  try {
    await fetchBridgeHealthWithRetries({ retries: 1, delayMs: 0 });
    return true;
  } catch (err) {
    return false;
  }
}

async function isHttpBridgeReachable() {
  try {
    await fetchBridgeHealth();
    return true;
  } catch (err) {
    if (/HTTP bridge alive but health returned/i.test(String(err && err.message || ''))) {
      log(`MT5 HTTP bridge is reachable but not fully ready: ${err.message}`);
      return true;
    }

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
    env: {
      ...process.env,
      MT5_BRIDGE_TIMEOUT_MS: String(config.mt5Bridge.timeoutMs),
    },
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
  const delayMs = Math.max(0, Number(config.startup.bridgeHealthRetryDelayMs || 2000));
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;

    if (await isHttpBridgeReachable()) {
      log(`MT5 HTTP bridge reachability attempt ${attempt} ok`);
      return true;
    }

    log(`MT5 HTTP bridge reachability attempt ${attempt} failed`);
    await delay(delayMs);
  }

  return false;
}

async function ensureHttpBridgeRunning() {
  if (!config.mt5Bridge.enabled || !config.mt5Bridge.autoStartHttpBridge) {
    return;
  }

  if (await isHttpBridgeReachable()) {
    log('MT5 HTTP bridge already reachable');
    return;
  }

  if (!fs.existsSync(venvPython)) {
    throw new Error(`MT5 auto-start expected Python at ${venvPython}`);
  }

  const existingPid = readBridgePid();

  if (isProcessAlive(existingPid)) {
    log(`Waiting for existing MT5 HTTP bridge process (pid ${existingPid})`);

    if (await waitForBridgeHealth(30000)) {
      log(`MT5 HTTP bridge became reachable (pid ${existingPid})`);
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
    log(`MT5 HTTP bridge started automatically and became reachable (pid ${child.pid})`);
    return;
  }

  throw new Error('Timed out waiting for MT5 HTTP bridge to become reachable');
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
    const health = await fetchBridgeHealthWithRetries({
      label: 'MT5 terminal bridge heartbeat',
      requireConnected: true,
    });

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
  fetchBridgeHealthWithRetries,
  ensureMt5RuntimeReady,
};
