#!/usr/bin/env node

/**
 * RouteCodex CLI - ESM entry point
 * Multi-provider OpenAI proxy server command line interface
 */

import { Command } from 'commander';
import chalk from 'chalk';
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
// Spinner wrapper (lazy-loaded to avoid hard dependency on ora/restore-cursor issues)
type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};
type OraModule = {
  default?: (text?: string) => Spinner;
};

async function createSpinner(text: string): Promise<Spinner> {
  const mod = await dynamicImport<OraModule>('ora');
  const oraFactory = typeof mod?.default === 'function' ? mod.default : undefined;
  if (oraFactory) {
    const instance = oraFactory(text);
    if (typeof instance.start === 'function') {
      instance.start(text);
      return instance;
    }
  }

  let currentText = text;
  const log = (prefix: string, msg?: string) => {
    const message = msg ?? currentText;
    if (!message) {
      return;
    }
    console.log(`${prefix} ${message}`);
  };

  const stub: Spinner = {
    start(msg?: string) {
      if (msg) {
        currentText = msg;
      }
      log('...', msg);
      return stub;
    },
    succeed(msg?: string) { log('✓', msg); },
    fail(msg?: string) { log('✗', msg); },
    warn(msg?: string) { log('⚠', msg); },
    info(msg?: string) { log('ℹ', msg); },
    stop() { /* no-op */ },
    get text() { return currentText; },
    set text(value: string) { currentText = value; }
  };

  return stub;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerConfig {
  port: number;
  host: string;
}

interface LoggingConfig {
  level: string;
}

type CodeCommandOptions = {
  port?: string;
  host: string;
  url?: string;
  config?: string;
  apikey?: string;
  claudePath?: string;
  cwd?: string;
  model?: string;
  profile?: string;
  ensureServer?: boolean;
};

// simple-log config type removed

interface HealthCheckResult {
  status: string;
  port: number;
  host: string;
  responseTime?: number;
  error?: string;
}

// Simple logger
const logger = {
  info: (msg: string) => console.log(`${chalk.blue('ℹ')  } ${  msg}`),
  success: (msg: string) => console.log(`${chalk.green('✓')  } ${  msg}`),
  warning: (msg: string) => console.log(`${chalk.yellow('⚠')  } ${  msg}`),
  error: (msg: string) => console.log(`${chalk.red('✗')  } ${  msg}`),
  debug: (msg: string) => console.log(`${chalk.gray('◉')  } ${  msg}`)
};

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// Ensure llmswitch-core is resolvable（dev/worktree 场景下由 pipeline 加载 vendor）
async function dynamicImport<T>(specifier: string): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return undefined;
  }
}

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
program
  .command('code')
  .description('Launch Claude Code interface with RouteCodex as proxy (args after this command are passed to Claude by default)')
  .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
  // Default to IPv4 localhost to avoid environments where localhost resolves to ::1
  .option('-h, --host <host>', 'RouteCodex server host', LOCAL_HOSTS.IPV4)
  .option('--url <url>', 'RouteCodex base URL (overrides host/port), e.g. https://code.codewhisper.cc')
  .option('-c, --config <config>', 'RouteCodex configuration file path')
  .option('--apikey <apikey>', 'RouteCodex server apikey (defaults to httpserver.apikey in config when present)')
  .option('--claude-path <path>', 'Path to Claude Code executable', 'claude')
  .option('--cwd <dir>', 'Working directory for Claude Code (defaults to current shell cwd)')
  .option('--model <model>', 'Model to use with Claude Code')
  .option('--profile <profile>', 'Claude Code profile to use')
  .option('--ensure-server', 'Ensure RouteCodex server is running before launching Claude')
  .argument('[extraArgs...]', 'Additional args to pass through to Claude')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (extraArgs: string[] = [], options: CodeCommandOptions) => {
    const extraArgsFromCommander = Array.isArray(extraArgs) ? extraArgs : [];
    const spinner = await createSpinner('Preparing Claude Code with RouteCodex...');

    try {
      const parseServerUrl = (
        raw: string
      ): { protocol: 'http' | 'https'; host: string; port: number | null; basePath: string } => {
        const trimmed = String(raw || '').trim();
        if (!trimmed) {
          throw new Error('--url is empty');
        }
        let parsed: URL;
        try {
          parsed = new URL(trimmed);
        } catch {
          parsed = new URL(`http://${trimmed}`);
        }
        const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
        const host = parsed.hostname;
        const hasExplicitPort = Boolean(parsed.port && parsed.port.trim());
        const port = hasExplicitPort ? Number(parsed.port) : null;
        const rawPath = typeof parsed.pathname === 'string' ? parsed.pathname : '';
        const basePath = rawPath && rawPath !== '/' ? rawPath.replace(/\/+$/, '') : '';
        return { protocol, host, port: Number.isFinite(port as number) ? (port as number) : null, basePath };
      };

      const readConfigApiKey = (configPath: string): string | null => {
        try {
          if (!configPath || !fs.existsSync(configPath)) {
            return null;
          }
          const txt = fs.readFileSync(configPath, 'utf8');
          const cfg = JSON.parse(txt);
          const direct = cfg?.httpserver?.apikey ?? cfg?.modules?.httpserver?.config?.apikey ?? cfg?.server?.apikey;
          const value = typeof direct === 'string' ? direct.trim() : '';
          return value ? value : null;
        } catch {
          return null;
        }
      };

      // Resolve configuration and determine port
      let configPath = options.config;
      if (!configPath) {
        configPath = path.join(homedir(), '.routecodex', 'config.json');
      }

      let actualProtocol: 'http' | 'https' = 'http';
      let actualPort = options.port ? parseInt(options.port, 10) : null;
      let actualHost = options.host;
      let actualBasePath = '';

      if (options.url && String(options.url).trim()) {
        const parsed = parseServerUrl(options.url);
        actualProtocol = parsed.protocol;
        actualHost = parsed.host || actualHost;
        actualPort = parsed.port ?? actualPort;
        actualBasePath = parsed.basePath;
      }

      // Determine effective port for code command:
      // - dev package (routecodex): env override, otherwise固定 5555，不读取配置端口
      // - release package (rcc): 按配置/参数解析端口
      if (IS_DEV_PACKAGE) {
        if (!actualPort) {
          const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
          actualPort = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_DEV_PORT;
          logger.info(`Using dev default port ${actualPort} for routecodex code (config ports ignored)`);
        }
      } else {
        // 非 dev 包：若未显式指定端口，则从配置文件解析
        if (!actualPort && fs.existsSync(configPath) && !(options.url && String(options.url).trim())) {
          try {
            const configContent = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configContent);
            actualPort = (config?.httpserver?.port ?? config?.server?.port ?? config?.port) || null;
            actualHost = (config?.httpserver?.host || config?.server?.host || config?.host || actualHost);
          } catch (error) {
            spinner.warn('Failed to read configuration file, using defaults');
          }
        }
      }

      // Require explicit port if not resolved (except when --url is used; default ports are implicit).
      if (!(options.url && String(options.url).trim()) && !actualPort) {
        spinner.fail('Invalid or missing port configuration for RouteCodex server');
        logger.error('Please set httpserver.port in your configuration (e.g., ~/.routecodex/config.json) or use --port');
        process.exit(1);
      }

      const configuredApiKey =
        (typeof options.apikey === 'string' && options.apikey.trim()
          ? options.apikey.trim()
          : null)
        ?? (typeof process.env.ROUTECODEX_APIKEY === 'string' && process.env.ROUTECODEX_APIKEY.trim()
          ? process.env.ROUTECODEX_APIKEY.trim()
          : null)
        ?? (typeof process.env.RCC_APIKEY === 'string' && process.env.RCC_APIKEY.trim()
          ? process.env.RCC_APIKEY.trim()
          : null)
        ?? readConfigApiKey(configPath);

      // Check if RouteCodex server needs to be started
      if (options.ensureServer) {
        spinner.text = 'Checking RouteCodex server status...';
        const normalizeConnectHost = (h: string): string => {
          const v = String(h || '').toLowerCase();
          if (v === '0.0.0.0') {return LOCAL_HOSTS.IPV4;}
          if (v === '::' || v === '::1' || v === 'localhost') {return LOCAL_HOSTS.IPV4;}
          return h || LOCAL_HOSTS.IPV4;
        };
        const connectHost = normalizeConnectHost(actualHost);
        const portPart = actualPort ? `:${actualPort}` : '';
        const serverUrl = `${actualProtocol}://${connectHost}${portPart}${actualBasePath}`;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const headers = configuredApiKey ? { 'x-api-key': configuredApiKey } : undefined;
          const response = await fetch(`${serverUrl}/ready`, { signal: controller.signal, method: 'GET', headers });
          clearTimeout(timeoutId);
          if (!response.ok) {throw new Error('Server not ready');}
          const j = await response.json().catch(() => ({}));
          if (j?.status !== 'ready') {throw new Error('Server reported not_ready');}
          spinner.succeed('RouteCodex server is ready');
        } catch (error) {
          if (options.url && String(options.url).trim()) {
            spinner.fail('RouteCodex server is not reachable (ensure-server with --url cannot auto-start)');
            logger.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
          }

          spinner.info('RouteCodex server is not running, starting it...');

          // Start RouteCodex server in background
          const { spawn } = await import('child_process');
          const modulesConfigPath = path.resolve(__dirname, '../config/modules.json');
          const serverEntry = path.resolve(__dirname, 'index.js');

          const serverProcess = spawn(process.execPath, [serverEntry, modulesConfigPath], {
            stdio: 'pipe',
            env: { ...process.env },
            detached: true
          });

          serverProcess.unref();

          // Wait for server to become ready (up to ~30s)
          spinner.text = 'Waiting for RouteCodex server to become ready...';
          let ready = false;
          for (let i = 0; i < 30; i++) {
            await sleep(1000);
            try {
              const headers = configuredApiKey ? { 'x-api-key': configuredApiKey } : undefined;
              const res = await fetch(`${serverUrl}/ready`, { method: 'GET', headers });
              if (res.ok) {
                const jr = await res.json().catch(() => ({}));
                if (jr?.status === 'ready') { ready = true; break; }
              }
            } catch { /* ignore */ }
          }
        if (ready) {
          spinner.succeed('RouteCodex server is ready');
        } else {
          spinner.warn('RouteCodex server may not be fully ready, continuing...');
        }
        }
      }

      spinner.text = 'Launching Claude Code...';

      // Prepare environment variables for Claude Code
      const resolvedBaseHost = String((() => {
        const v = String(actualHost || '').toLowerCase();
        if (v === '0.0.0.0') {return LOCAL_HOSTS.IPV4;}
        if (v === '::' || v === '::1' || v === 'localhost') {return LOCAL_HOSTS.IPV4;}
        return actualHost || LOCAL_HOSTS.IPV4;
      })());
      const portPart = actualPort ? `:${actualPort}` : '';
      const anthropicBase = `${actualProtocol}://${resolvedBaseHost}${portPart}${actualBasePath}`;
      const currentCwd = (() => {
        try {
          const d = options.cwd ? String(options.cwd) : process.cwd();
          const resolved = path.resolve(d);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
        } catch {
          return process.cwd();
        }
        return process.cwd();
      })();
      const claudeEnv = {
        ...process.env,
        // Normalize working directory context for downstream tools
        PWD: currentCwd,
        RCC_WORKDIR: currentCwd,
        ROUTECODEX_WORKDIR: currentCwd,
        CLAUDE_WORKDIR: currentCwd,
        // Cover both common env var names used by Anthropic SDK / tools
        ANTHROPIC_BASE_URL: anthropicBase,
        ANTHROPIC_API_URL: anthropicBase,
        ANTHROPIC_API_KEY: configuredApiKey || 'rcc-proxy-key'
      } as NodeJS.ProcessEnv;
      // Avoid auth conflict: prefer API key routed via RouteCodex; remove shell tokens
      try { delete (claudeEnv as Record<string, unknown>)['ANTHROPIC_AUTH_TOKEN']; } catch { /* ignore */ }
      try { delete (claudeEnv as Record<string, unknown>)['ANTHROPIC_TOKEN']; } catch { /* ignore */ }
      logger.info('Unset ANTHROPIC_AUTH_TOKEN/ANTHROPIC_TOKEN for Claude process to avoid conflicts');
      logger.info(`Setting Anthropic base URL to: ${anthropicBase}`);

      // Prepare Claude Code command arguments（将 rcc code 后面的原始参数默认透传给 Claude）
      const claudeArgs: string[] = [];

      if (options.model) {
        claudeArgs.push('--model', options.model);
      }

      if (options.profile) {
        claudeArgs.push('--profile', options.profile);
      }

      // 透传用户紧随 `rcc code` 之后的参数（默认行为）
      try {
        const rawArgv = process.argv.slice(2); // drop node/bin and script
        const idxCode = rawArgv.findIndex(a => a === 'code');
        const afterCode = idxCode >= 0 ? rawArgv.slice(idxCode + 1) : [];
        // 支持显式分隔符 -- ：其后的所有参数原样传给 Claude
        const sepIndex = afterCode.indexOf('--');
        const tail = sepIndex >= 0 ? afterCode.slice(sepIndex + 1) : afterCode;
        // 过滤本命令自身已识别的选项，剩余的作为透传参数
        const knownOpts = new Set([
          '-p',
          '--port',
          '-h',
          '--host',
          '--url',
          '-c',
          '--config',
          '--apikey',
          '--claude-path',
          '--model',
          '--profile',
          '--ensure-server'
        ]);
        const requireValue = new Set([
          '-p',
          '--port',
          '-h',
          '--host',
          '--url',
          '-c',
          '--config',
          '--apikey',
          '--claude-path',
          '--model',
          '--profile'
        ]);
        const passThrough: string[] = [];
        for (let i = 0; i < tail.length; i++) {
          const tok = tail[i];
          if (knownOpts.has(tok)) {
            if (requireValue.has(tok)) {
              i++;
            }
            continue;
          }
          // 若是组合形式 --opt=value 且 opt 为已识别的，跳过
          if (tok.startsWith('--')) {
            const eq = tok.indexOf('=');
            if (eq > 2) {
              const optName = tok.slice(0, eq);
              if (knownOpts.has(optName)) { continue; }
            }
          }
          passThrough.push(tok);
        }
        // 合并 Commander 捕获到的额外参数（多数为位置参数），与我们手动解析的尾参数，去重保序
        const merged: string[] = [];
        const seen = new Set<string>();
        const pushUnique = (arr: string[]) => { for (const t of arr) { if (!seen.has(t)) { seen.add(t); merged.push(t); } } };
        pushUnique(extraArgsFromCommander);
        pushUnique(passThrough);
        if (merged.length) { claudeArgs.push(...merged); }
      } catch {
        // ignore passthrough errors
        void 0;
      }

      // Launch Claude Code
      const { spawn } = await import('child_process');
      const claudeBin = ((): string => {
        try {
          const v = String(options?.claudePath || '').trim();
          if (v) {
            return v;
          }
        } catch {
          // ignore
        }
        const envPath = String(process.env.CLAUDE_PATH || '').trim();
        return envPath || 'claude';
      })();
      // Windows: Node spawn does not resolve .cmd shims unless using a shell. Prefer shell for bare commands.
      const shouldUseShell =
        IS_WINDOWS &&
        !path.extname(claudeBin) &&
        !claudeBin.includes('/') &&
        !claudeBin.includes('\\');
      const claudeProcess = spawn(claudeBin, claudeArgs, {
        stdio: 'inherit',
        env: claudeEnv,
        cwd: currentCwd,
        shell: shouldUseShell
      });

      spinner.succeed('Claude Code launched with RouteCodex proxy');
      // Log normalized IPv4 host to avoid confusion (do not print ::/localhost)
      logger.info(`Using RouteCodex server at: http://${resolvedBaseHost}:${actualPort}`);
      logger.info(`Claude binary: ${claudeBin}`);
      logger.info(`Working directory for Claude: ${currentCwd}`);
      logger.info('Press Ctrl+C to exit Claude Code');

      // Handle graceful shutdown
      const shutdown = async (sig: NodeJS.Signals) => {
        try { claudeProcess.kill(sig); } catch { /* ignore */ }
        try { process.exit(0); } catch { /* ignore */ }
      };

      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

      claudeProcess.on('error', (err) => {
        try {
          logger.error(`Failed to launch Claude Code (${claudeBin}): ${err instanceof Error ? err.message : String(err)}`);
          if (IS_WINDOWS && shouldUseShell) {
            logger.error('Tip: If Claude is installed via npm, ensure the shim is in PATH (e.g. claude.cmd).');
          }
        } catch { /* ignore */ }
        process.exit(1);
      });

      claudeProcess.on('exit', (code, signal) => {
        if (signal) {
          process.exit(0);
        } else {
          process.exit(code ?? 0);
        }
      });

      // Keep process alive
      await new Promise<void>(() => {
        // Keep process alive until interrupted
        return;
      });

    } catch (error) {
      spinner.fail('Failed to launch Claude Code');
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
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
program
  .command('start')
  .description('Start the RouteCodex server')
  .option('-c, --config <config>', 'Configuration file path')
  .option('-p, --port <port>', 'RouteCodex server port (dev package only; overrides env/config)')
  .option('--quota-routing <mode>', 'Quota routing admission control (on|off). off => do not remove providers from pool based on quota')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--codex', 'Use Codex system prompt (tools unchanged)')
  .option('--claude', 'Use Claude system prompt (tools unchanged)')
  .option('--ua <mode>', 'Upstream User-Agent override mode (e.g., codex)')
  .option('--snap', 'Force-enable snapshot capture')
  .option('--snap-off', 'Disable snapshot capture')
  .option('--verbose-errors', 'Print verbose error stacks in console output')
  .option('--quiet-errors', 'Silence detailed error stacks')
  .option('--restart', 'Restart if an instance is already running')
  .option('--exclusive', 'Always take over the port (kill existing listeners)')
  .action(async (options) => {
    const spinner = await createSpinner('Starting RouteCodex server...');

    try {
      // Validate system prompt replacement flags
      try {
        if (options.codex && options.claude) {
          spinner.fail('Flags --codex and --claude are mutually exclusive');
          process.exit(1);
        }
        const promptFlag = options.codex ? 'codex' : (options.claude ? 'claude' : null);
        if (promptFlag) {
          process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = promptFlag;
          process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE = '1';
        }
        const uaFromFlag =
          typeof options.ua === 'string' && options.ua.trim()
            ? options.ua.trim()
            : null;
        const uaMode = uaFromFlag || (options.codex ? 'codex' : null);
        if (uaMode) {
          process.env.ROUTECODEX_UA_MODE = uaMode;
        }
        if (options.snap && options.snapOff) {
          spinner.fail('Flags --snap and --snap-off are mutually exclusive');
          process.exit(1);
        }
        if (options.snap) {
          process.env.ROUTECODEX_SNAPSHOT = '1';
        } else if (options.snapOff) {
          process.env.ROUTECODEX_SNAPSHOT = '0';
        }
        if (options.verboseErrors && options.quietErrors) {
          spinner.fail('Flags --verbose-errors and --quiet-errors are mutually exclusive');
          process.exit(1);
        }
        if (options.verboseErrors) {
          process.env.ROUTECODEX_VERBOSE_ERRORS = '1';
        } else if (options.quietErrors) {
          process.env.ROUTECODEX_VERBOSE_ERRORS = '0';
        }
      } catch { /* ignore */ }

      // Resolve config path
      let configPath = options.config;
      if (!configPath) {
        configPath = path.join(homedir(), '.routecodex', 'config.json');
      }

      // Ensure provided config path is a file (not a directory)
      if (fs.existsSync(configPath)) {
        const stats = fs.statSync(configPath);
        if (stats.isDirectory()) {
          spinner.fail(`Configuration path must be a file, received directory: ${configPath}`);
          process.exit(1);
        }
      }

      // Check if config exists; do NOT create defaults
      if (!fs.existsSync(configPath)) {
        spinner.fail(`Configuration file not found: ${configPath}`);
        logger.error('Please create a RouteCodex user config first (e.g., ~/.routecodex/config.json).');
        logger.error('Or initialize via CLI:');
        logger.error('  rcc config init');
        logger.error('Or specify a custom configuration file:');
        logger.error('  rcc start --config ./my-config.json');
        process.exit(1);
      }

      // Load and validate configuration (non-dev packages rely on config port)
      let config;
  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configContent);
  } catch (error) {
        spinner.fail('Failed to parse configuration file');
        logger.error(`Invalid JSON in configuration file: ${configPath}`);
        process.exit(1);
      }

      const parseBoolish = (value: unknown): boolean | undefined => {
        if (typeof value !== 'string') {
          return undefined;
        }
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
          return undefined;
        }
        if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === 'enable' || normalized === 'enabled') {
          return true;
        }
        if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === 'disable' || normalized === 'disabled') {
          return false;
        }
        return undefined;
      };

      const quotaRoutingOverride = parseBoolish((options as { quotaRouting?: unknown }).quotaRouting);
      if ((options as { quotaRouting?: unknown }).quotaRouting !== undefined && quotaRoutingOverride === undefined) {
        spinner.fail('Invalid --quota-routing value. Use on|off');
        process.exit(1);
      }
      if (typeof quotaRoutingOverride === 'boolean') {
        const carrier = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
        const httpserver =
          carrier.httpserver && typeof carrier.httpserver === 'object' && carrier.httpserver !== null
            ? (carrier.httpserver as Record<string, unknown>)
            : {};
        carrier.httpserver = {
          ...httpserver,
          quotaRoutingEnabled: quotaRoutingOverride
        };
        config = carrier;

        const dir = fs.mkdtempSync(path.join(tmpdir(), 'routecodex-config-'));
        const patchedPath = path.join(dir, 'config.json');
        fs.writeFileSync(patchedPath, JSON.stringify(config, null, 2), 'utf8');
        configPath = patchedPath;
        spinner.info(`quota routing override: ${quotaRoutingOverride ? 'on' : 'off'} (temp config)`);
      }

      // Determine effective port:
      // - dev package (`routecodex`): env override, otherwise固定端口 5555（完全忽略配置中的端口）
      // - release package (`rcc`): 严格按配置文件端口启动
      let resolvedPort: number;
      if (IS_DEV_PACKAGE) {
        const flagPort = typeof options.port === 'string' ? Number(options.port) : NaN;
        if (!Number.isNaN(flagPort) && flagPort > 0) {
          logger.info(`Using port ${flagPort} from --port flag [dev package: routecodex]`);
          resolvedPort = flagPort;
        } else {
          const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
          if (!Number.isNaN(envPort) && envPort > 0) {
            logger.info(`Using port ${envPort} from environment (ROUTECODEX_PORT/RCC_PORT) [dev package: routecodex]`);
            resolvedPort = envPort;
          } else {
            resolvedPort = DEFAULT_DEV_PORT;
            logger.info(`Using dev default port ${resolvedPort} (routecodex dev package)`);
          }
        }
      } else {
        const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
        if (!port || typeof port !== 'number' || port <= 0) {
          spinner.fail('Invalid or missing port configuration');
          logger.error('Please set a valid port (httpserver.port or top-level port) in your configuration');
          process.exit(1);
        }
        resolvedPort = port;
      }

      // Ensure port state aligns with requested behavior (always take over to avoid duplicates)
      await ensurePortAvailable(resolvedPort, spinner, { restart: true });

      const resolveServerHost = (): string => {
        if (typeof config?.httpserver?.host === 'string' && config.httpserver.host.trim()) {
          return config.httpserver.host;
        }
        if (typeof config?.server?.host === 'string' && config.server.host.trim()) {
          return config.server.host;
        }
        if (typeof config?.host === 'string' && config.host.trim()) {
          return config.host;
        }
        return LOCAL_HOSTS.LOCALHOST;
      };
      const serverHost = resolveServerHost();
      process.env.ROUTECODEX_PORT = String(resolvedPort);
      process.env.RCC_PORT = String(resolvedPort);
      process.env.ROUTECODEX_HTTP_HOST = serverHost;
      process.env.ROUTECODEX_HTTP_PORT = String(resolvedPort);
      await ensureLocalTokenPortalEnv();

      // Best-effort auto-start of token daemon (can be disabled via env)
      await ensureTokenDaemonAutoStart();

      // simple-log application removed

      // Resolve modules config path
      const modulesConfigPath = getModulesConfigPath();
      if (!fs.existsSync(modulesConfigPath)) {
        spinner.fail(`Modules configuration file not found: ${modulesConfigPath}`);
        process.exit(1);
      }

      // resolvedPort already determined above

      // Spawn child Node process to run the server entry; forward signals
      const nodeBin = process.execPath; // current Node
      const serverEntry = path.resolve(__dirname, 'index.js');
      // Use spawn (not spawnSync); import child_process at top already
      const { spawn } = await import('child_process');

      const env = { ...process.env } as NodeJS.ProcessEnv;
      // Ensure server process picks the intended user config path
      env.ROUTECODEX_CONFIG = configPath;
      env.ROUTECODEX_CONFIG_PATH = configPath;
      // 对 dev 包（routecodex），强制通过环境变量传递端口，确保服务器与 CLI 使用同一个 5555/自定义端口
      if (IS_DEV_PACKAGE) {
        env.ROUTECODEX_PORT = String(resolvedPort);
      }
      const args: string[] = [serverEntry, modulesConfigPath];

      const childProc = spawn(nodeBin, args, { stdio: 'inherit', env });
      // Persist child pid for out-of-band stop diagnostics
      try {
        const pidFile = path.join(homedir(), '.routecodex', 'server.cli.pid');
        fs.writeFileSync(pidFile, String(childProc.pid ?? ''), 'utf8');
      } catch (error) { /* ignore */ }

      const host = serverHost;
      spinner.succeed(`RouteCodex server starting on ${host}:${resolvedPort}`);
      logger.info(`Configuration loaded from: ${configPath}`);
      logger.info(`Server will run on port: ${resolvedPort}`);
      logger.info('Press Ctrl+C to stop the server');

      // Forward signals to child
      const shutdown = async (sig: NodeJS.Signals) => {
        // 1) Ask server to shutdown over HTTP
        try {
          await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {});
        } catch (error) { /* ignore */ }
        // 2) Forward signal to child
        try { childProc.kill(sig); } catch (error) { /* ignore */ }
        if (!IS_WINDOWS) {
          try { if (childProc.pid) { process.kill(-childProc.pid, sig); } } catch (error) { /* ignore */ }
        }
        // 3) Wait briefly; if still listening, try SIGTERM/SIGKILL by port
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) {break;}
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        if (remain.length) {
          for (const pid of remain) {
            killPidBestEffort(pid, { force: false });
          }
          const killDeadline = Date.now() + 1500;
          while (Date.now() < killDeadline) {
            if (findListeningPids(resolvedPort).length === 0) {break;}
            await sleep(100);
          }
        }
        const still = findListeningPids(resolvedPort);
        if (still.length) {
          for (const pid of still) {
            killPidBestEffort(pid, { force: true });
          }
        }
        if (IS_DEV_PACKAGE) {
          await stopTokenDaemonIfRunning();
        }
        // Ensure parent exits even if child fails to exit
        try { process.exit(0); } catch { /* ignore */ }
      };
      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

      // Fallback keypress handler: capture Ctrl+C / q when some environments swallow SIGINT
      const cleanupKeypress = setupKeypress(() => { void shutdown('SIGINT'); });

      childProc.on('exit', (code, signal) => {
        // Propagate exit code
        try { cleanupKeypress(); } catch { /* ignore */ }
        if (signal) {
          process.exit(0);
        } else {
          process.exit(code ?? 0);
        }
      });

      // Do not exit parent; keep process alive to relay signals
      await new Promise<void>(() => {
        // Keep supervisor alive until shutdown completes
        return;
      });

    } catch (error) {
      spinner.fail('Failed to start server');
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
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
