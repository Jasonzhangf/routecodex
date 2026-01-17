#!/usr/bin/env node

/**
 * RouteCodex CLI - ESM entry point
 * Multi-provider OpenAI proxy server command line interface
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir, tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS, DEFAULT_CONFIG, API_ENDPOINTS } from './constants/index.js';
import { buildInfo } from './build-info.js';
import { ensureLocalTokenPortalEnv } from './token-portal/local-token-portal.js';
import { parseNetstatListeningPids } from './utils/windows-netstat.js';
import { createEnvCommand } from './cli/commands/env.js';
import { createPortCommand } from './cli/commands/port.js';
import { createCleanCommand } from './cli/commands/clean.js';
import { createExamplesCommand } from './cli/commands/examples.js';
import { createStatusCommand } from './cli/commands/status.js';
import { loadRouteCodexConfig } from './config/routecodex-config-loader.js';
import { createConfigCommand } from './cli/commands/config.js';
import { createStopCommand } from './cli/commands/stop.js';
import { createRestartCommand } from './cli/commands/restart.js';
import { createStartCommand } from './cli/commands/start.js';
import { createCodeCommand } from './cli/commands/code.js';
import { createSpinner, type Spinner } from './cli/spinner.js';
import { logger } from './cli/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerConfig {
  port: number;
  host: string;
}

interface LoggingConfig {
  level: string;
}

// simple-log config type removed

interface HealthCheckResult {
  status: string;
  port: number;
  host: string;
  responseTime?: number;
  error?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

async function ensureCoreOrFail(): Promise<void> {
// 在当前 worktree/dev 场景下：
// - llmswitch-core 直接通过 sharedmodule/llmswitch-core/dist 引用；
// - 实际加载在 pipeline/server 模块内部完成；
// 这里不再做额外的模块解析探测，避免因为本地 node_modules 结构差异导致 CLI 直接失败。
  return;
}

// Top-level guard（Fail Fast，无兜底）
await ensureCoreOrFail();

// CLI program setup
const program = new Command();

// Resolve version from package.json at runtime to avoid hardcoding mismatches
const pkgVersion: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const txt = fs.readFileSync(pkgPath, 'utf-8');
    const j = JSON.parse(txt);
    return typeof j?.version === 'string' ? j.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const cliVersion = buildInfo?.version ?? pkgVersion;

// Resolve package name for display / binary naming
const pkgName: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const txt = fs.readFileSync(pkgPath, 'utf-8');
    const j = JSON.parse(txt);
    if (typeof j?.name === 'string' && j.name.trim()) {
      return j.name.trim();
    }
  } catch {
    // ignore and fall back
  }
  return 'routecodex';
})();

// 包变体：
// - routecodex（dev 包）：默认端口 5555，用于本地开发调试，不读取配置端口，除非显式设置 ROUTECODEX_PORT/RCC_PORT
// - rcc（release 包）：严格按配置文件端口启动（httpserver.port/server.port/port）
const IS_DEV_PACKAGE = pkgName === 'routecodex';
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_DEV_PORT = 5555;
const TOKEN_DAEMON_PID_FILE = path.join(homedir(), '.routecodex', 'token-daemon.pid');
program
  .name(pkgName === 'rcc' ? 'rcc' : 'routecodex')
  .description('RouteCodex CLI - Multi-provider OpenAI proxy server and Claude Code interface')
  .version(cliVersion);

async function ensureTokenDaemonAutoStart(): Promise<void> {
  // Token 刷新逻辑已经在服务器进程内通过 ManagerDaemon/TokenManagerModule 执行。
  // 为避免重复启动独立的 token-daemon 进程，这里不再自动拉起后台守护，仅保留显式 CLI 命令。
  const disabledEnv = String(
    process.env.ROUTECODEX_TOKEN_DAEMON_DISABLED || process.env.RCC_TOKEN_DAEMON_DISABLED || ''
  )
    .trim()
    .toLowerCase();
  if (disabledEnv !== '1' && disabledEnv !== 'true' && disabledEnv !== 'yes') {
    logger.info(
      'Token manager is now integrated into the server process; automatic external token-daemon auto-start is disabled.'
    );
  }
}

function killPidBestEffort(pid: number, opts: { force: boolean }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (IS_WINDOWS) {
    const args = ['/PID', String(pid), '/T'];
    if (opts.force) {
      args.push('/F');
    }
    try {
      spawnSync('taskkill', args, { stdio: 'ignore', encoding: 'utf8' });
    } catch {
      // best-effort
    }
    return;
  }
  try {
    process.kill(pid, opts.force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // best-effort
  }
}

async function stopTokenDaemonIfRunning(): Promise<void> {
  try {
    if (!fs.existsSync(TOKEN_DAEMON_PID_FILE)) {
      return;
    }
    const txt = fs.readFileSync(TOKEN_DAEMON_PID_FILE, 'utf8');
    const parsed = Number(String(txt || '').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    const pid = parsed;
    let running = false;
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
    if (!running) {
      try { fs.unlinkSync(TOKEN_DAEMON_PID_FILE); } catch { /* ignore */ }
      return;
    }
    try {
      killPidBestEffort(pid, { force: false });
    } catch {
      // ignore
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { fs.unlinkSync(TOKEN_DAEMON_PID_FILE); } catch { /* ignore */ }
  } catch {
    // best-effort: failures here must not break CLI shutdown
  }
}

// Provider command group - update models and generate minimal provider config
try {
  const { createProviderUpdateCommand } = await import('./commands/provider-update.js');
  program.addCommand(createProviderUpdateCommand());
} catch { /* optional: command not available in some builds */ }

// Camoufox fingerprint debug command (optional)
try {
  const { createCamoufoxFpCommand } = await import('./commands/camoufox-fp.js');
  program.addCommand(createCamoufoxFpCommand());
} catch { /* optional */ }

// Camoufox fingerprint backfill command (optional)
try {
  const { createCamoufoxBackfillCommand } = await import('./commands/camoufox-backfill.js');
  program.addCommand(createCamoufoxBackfillCommand());
} catch { /* optional */ }

// Token daemon command group - manage OAuth tokens
try {
  const { createTokenDaemonCommand } = await import('./commands/token-daemon.js');
  program.addCommand(createTokenDaemonCommand());
} catch { /* optional: command not available in some builds */ }

// Quota status command - inspect daemon-managed quota snapshot
try {
  const { createQuotaStatusCommand } = await import('./commands/quota-status.js');
  program.addCommand(createQuotaStatusCommand());
} catch { /* optional */ }

// Quota daemon command - offline replay/once maintenance for provider-quota snapshot
try {
  const { createQuotaDaemonCommand } = await import('./commands/quota-daemon.js');
  program.addCommand(createQuotaDaemonCommand());
} catch { /* optional */ }

// OAuth command - force re-auth for a specific token (Camoufox-aware when enabled)
try {
  const { createOauthCommand } = await import('./commands/oauth.js');
  program.addCommand(createOauthCommand());
} catch { /* optional: command not available in some builds */ }

// Validate command - auto start server then run E2E checks
try {
  const { createValidateCommand } = await import('./commands/validate.js');
  program.addCommand(createValidateCommand());
} catch { /* optional */ }

// Code command - Launch Claude Code interface
createCodeCommand(program, {
  isDevPackage: IS_DEV_PACKAGE,
  isWindows: IS_WINDOWS,
  defaultDevPort: DEFAULT_DEV_PORT,
  nodeBin: process.execPath,
  createSpinner,
  logger,
  env: process.env,
  rawArgv: process.argv.slice(2),
  homedir,
  cwd: () => process.cwd(),
  sleep,
  fetch,
  spawn: (cmd, args, opts) => spawn(cmd, args, opts),
  getModulesConfigPath,
  resolveServerEntryPath: () => path.resolve(__dirname, 'index.js'),
  waitForever: () =>
    new Promise<void>(() => {
      return;
    }),
  onSignal: (sig, cb) => process.on(sig, cb),
  exit: (code) => process.exit(code)
});

// Env command - Print env exports for Anthropic proxy
createEnvCommand(program, {
  isDevPackage: IS_DEV_PACKAGE,
  defaultDevPort: DEFAULT_DEV_PORT,
  log: (line) => console.log(line),
  error: (line) => logger.error(line),
  exit: (code) => process.exit(code)
});

// Start command
createStartCommand(program, {
  isDevPackage: IS_DEV_PACKAGE,
  isWindows: IS_WINDOWS,
  defaultDevPort: DEFAULT_DEV_PORT,
  nodeBin: process.execPath,
  createSpinner,
  logger,
  env: process.env,
  fsImpl: fs,
  pathImpl: path,
  homedir,
  tmpdir,
  sleep,
  ensureLocalTokenPortalEnv,
  ensureTokenDaemonAutoStart,
  stopTokenDaemonIfRunning,
  ensurePortAvailable,
  findListeningPids,
  killPidBestEffort,
  getModulesConfigPath,
  resolveServerEntryPath: () => path.resolve(__dirname, 'index.js'),
  spawn: (cmd, args, opts) => spawn(cmd, args, opts),
  fetch,
  setupKeypress,
  waitForever: () =>
    new Promise<void>(() => {
      return;
    }),
  onSignal: (sig, cb) => process.on(sig, cb),
  exit: (code) => process.exit(code)
});

// Config command
createConfigCommand(program, { logger, createSpinner });

// Stop command
createStopCommand(program, {
  isDevPackage: IS_DEV_PACKAGE,
  defaultDevPort: DEFAULT_DEV_PORT,
  createSpinner,
  logger,
  findListeningPids,
  killPidBestEffort,
  sleep,
  stopTokenDaemonIfRunning,
  env: process.env,
  exit: (code) => process.exit(code)
});

// Restart command (stop + start with same environment)
createRestartCommand(program, {
  isDevPackage: IS_DEV_PACKAGE,
  isWindows: IS_WINDOWS,
  defaultDevPort: DEFAULT_DEV_PORT,
  createSpinner,
  logger,
  findListeningPids,
  killPidBestEffort,
  sleep,
  getModulesConfigPath,
  resolveServerEntryPath: () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js'),
  nodeBin: process.execPath,
  spawn: (cmd, args, opts) => spawn(cmd, args, opts),
  fetch,
  setupKeypress,
  waitForever: () =>
    new Promise<void>(() => {
      return;
    }),
  env: process.env,
  exit: (code) => process.exit(code),
  onSignal: (sig, cb) => {
    process.on(sig, cb);
  }
});

// Status command
createStatusCommand(program, {
  logger,
  log: (line) => console.log(line),
  loadConfig: () => loadRouteCodexConfig(),
  fetch
});

// Clean command: purge local capture and debug data for fresh runs
createCleanCommand(program, { logger });

// Import commands at top level
// offline-log CLI temporarily disabled to simplify build

// simple-log config helper removed

// Add commands
// dry-run commands removed
// offline-log command disabled
// simple-log command removed

// Examples command
createExamplesCommand(program, { log: (line) => console.log(line) });

async function ensurePortAvailable(port: number, parentSpinner: Spinner, opts: { restart?: boolean } = {}): Promise<void> {
  if (!port || Number.isNaN(port)) { return; }

  // Best-effort HTTP shutdown on common loopback hosts to cover IPv4/IPv6
  try {
    const candidates = [LOCAL_HOSTS.IPV4, LOCAL_HOSTS.LOCALHOST];
    for (const h of candidates) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => { try { controller.abort(); } catch (error) { /* ignore */ } }, 700);
        await fetch(`http://${h}:${port}/shutdown`, { method: 'POST', signal: controller.signal }).catch(() => {});
        clearTimeout(t);
      } catch (error) { /* ignore */ }
    }
    await sleep(300);
  } catch { /* ignore */ }

  const initialPids = findListeningPids(port);
  if (initialPids.length === 0) { return; }

  // If a healthy server is already running and no restart requested, report and exit gracefully
  const healthy = await isServerHealthyQuick(port);
  if (healthy && !opts.restart) {
    parentSpinner.stop();
    logger.success(`RouteCodex is already running on port ${port}.`);
    logger.info(`Use 'rcc stop' or 'rcc start --restart' to restart.`);
    process.exit(0);
  }

  parentSpinner.stop();
  logger.warning(`Port ${port} is in use by PID(s): ${initialPids.join(', ')}`);
  const stopSpinner = await createSpinner(`Port ${port} is in use on 0.0.0.0. Attempting graceful stop...`);
  const gracefulTimeout = Number(process.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
  const killTimeout = Number(process.env.ROUTECODEX_KILL_TIMEOUT_MS ?? 3000);
  const pollInterval = 150;

  for (const pid of initialPids) {
    try {
      killPidBestEffort(pid, { force: false });
    } catch (error) {
      stopSpinner.warn(`Failed to send SIGTERM to PID ${pid}: ${(error as Error).message}`);
    }
  }

  const gracefulDeadline = Date.now() + gracefulTimeout;
  while (Date.now() < gracefulDeadline) {
    if (findListeningPids(port).length === 0) {
      stopSpinner.succeed(`Port ${port} freed after graceful stop.`);
      logger.success(`Port ${port} freed after graceful stop.`);
      parentSpinner.start('Starting RouteCodex server...');
      return;
    }
    await sleep(pollInterval);
  }

  let remaining = findListeningPids(port);
  if (remaining.length) {
    stopSpinner.warn(`Graceful stop timed out, sending SIGKILL to PID(s): ${remaining.join(', ')}`);
    logger.warning(`Graceful stop timed out. Forcing SIGKILL to PID(s): ${remaining.join(', ')}`);
    for (const pid of remaining) {
      try {
        killPidBestEffort(pid, { force: true });
      } catch (error) {
        const message = (error as Error).message;
        stopSpinner.warn(`Failed to send SIGKILL to PID ${pid}: ${message}`);
        logger.error(`Failed to SIGKILL PID ${pid}: ${message}`);
      }
    }

    const killDeadline = Date.now() + killTimeout;
    while (Date.now() < killDeadline) {
      if (findListeningPids(port).length === 0) {
        stopSpinner.succeed(`Port ${port} freed after SIGKILL.`);
        logger.success(`Port ${port} freed after SIGKILL.`);
        parentSpinner.start('Starting RouteCodex server...');
        return;
      }
      await sleep(pollInterval);
    }
  }

  remaining = findListeningPids(port);
  if (remaining.length) {
    stopSpinner.fail(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    logger.error(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    throw new Error(`Failed to free port ${port}`);
  }

  stopSpinner.succeed(`Port ${port} freed.`);
  logger.success(`Port ${port} freed.`);
  parentSpinner.start('Starting RouteCodex server...');
}

function findListeningPids(port: number): number[] {
  try {
    if (IS_WINDOWS) {
      const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      if (result.error) {
        logger.warning(`netstat not available to inspect port usage: ${result.error.message}`);
        return [];
      }
      return parseNetstatListeningPids(result.stdout || '', port);
    }

    // macOS/BSD lsof expects either "-i TCP:port" or "-tiTCP:port" as a single argument.
    // Use the compact form to avoid treating ":port" as a filename.
    const result = spawnSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.error) {
      logger.warning(`lsof not available to inspect port usage: ${result.error.message}`);
      return [];
    }
    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      return [];
    }
    return stdout
      .split(/\s+/)
      .map((value) => parseInt(value, 10))
      .filter((pid) => !Number.isNaN(pid));
  } catch (error) {
    logger.warning(`Failed to inspect port ${port}: ${(error as Error).message}`);
    return [];
  }
}

// Fallback keypress setup: capture Ctrl+C and 'q' to trigger shutdown when SIGINT is not delivered
function setupKeypress(onInterrupt: () => void): () => void {
  try {
    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (v: boolean) => void;
      resume?: () => void;
      pause?: () => void;
      on?: (ev: string, cb: (data: Buffer) => void) => void;
      off?: (ev: string, cb: (data: Buffer) => void) => void;
    };
    if (stdin && stdin.isTTY) {
      const onData = (data: Buffer) => {
        const s = data.toString('utf8');
        // Ctrl+C
        if (s === '\u0003') { try { onInterrupt(); } catch { /* ignore */ } return; }
        // 'q' or 'Q' quick quit
        if (s === 'q' || s === 'Q') { try { onInterrupt(); } catch { /* ignore */ } return; }
      };
      stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.on?.('data', onData);
      return () => {
        try { stdin.off?.('data', onData); } catch { /* ignore */ }
        try { stdin.setRawMode?.(false); } catch { /* ignore */ }
        try { stdin.pause?.(); } catch { /* ignore */ }
      };
    }
  } catch {
    /* ignore */
  }
  return () => {
    // No-op cleanup when stdin is not interactive
    return;
  };
}

async function isServerHealthyQuick(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 800);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.HEALTH}`, { method: 'GET', signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) { return false; }
    const data = await res.json().catch(() => null);
    return !!data && (data.status === 'healthy' || data.status === 'ready');
  } catch (error) {
    return false;
  }
}

function getModulesConfigPath(): string {
  return path.resolve(__dirname, '../config/modules.json');
}


// Port utilities: doctor
createPortCommand(program, {
  defaultPort: DEFAULT_CONFIG.PORT,
  createSpinner,
  findListeningPids,
  killPidBestEffort,
  sleep,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  exit: (code) => process.exit(code)
});

// Parse command line arguments (must be last)
program.parse();
