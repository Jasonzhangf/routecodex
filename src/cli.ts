#!/usr/bin/env node

/**
 * RouteCodex CLI - ESM entry point
 * Multi-provider OpenAI proxy server command line interface
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS, DEFAULT_CONFIG, API_ENDPOINTS } from "./constants/index.js";import fs from 'fs';
import ora from 'ora';
import type { Ora } from 'ora';
import path from "path";import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import type { UnknownObject } from './types/common-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerConfig {
  port: number;
  host: string;
}

interface LoggingConfig {
  level: string;
}

interface ProvidersConfig {
  [key: string]: unknown;
}

interface DefaultConfig {
  server: ServerConfig;
  logging: LoggingConfig;
  providers: ProvidersConfig;
}

interface TemplateConfig {
  server?: Partial<ServerConfig>;
  logging?: Partial<LoggingConfig>;
  [key: string]: unknown;
}

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

// Ensure llmswitch-core is resolvable；先尝试依赖包，失败则回退到 vendor
async function dynamicImport(p: string): Promise<any> {
  // Avoid TypeScript/ESM static resolution so we can probe optional entries safely
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = Function('p', 'return import(p)');
  return fn(p);
}

async function ensureCoreOrFail(): Promise<void> {
  // 仅通过 npm 依赖检测（移除 vendor 兜底）
  try { await dynamicImport('rcc-llmswitch-core/package.json'); return; } catch { /* ignore */ }
  try { await dynamicImport('rcc-llmswitch-core'); return; } catch { /* ignore */ }

  logger.error('llmswitch-core not found via npm dependency.');
  logger.error('请先安装依赖: npm i rcc-llmswitch-core@latest，再执行构建与全局安装。');
  process.exit(1);
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

program
  .name('rcc')
  .description('RouteCodex CLI - Multi-provider OpenAI proxy server and Claude Code interface')
  .version(pkgVersion);

// Code command - Launch Claude Code interface
program
  .command('code')
  .description('Launch Claude Code interface with RouteCodex as proxy (args after this command are passed to Claude by default)')
  .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
  // Default to IPv4 localhost to avoid environments where localhost resolves to ::1
  .option('-h, --host <host>', 'RouteCodex server host', LOCAL_HOSTS.IPV4)
  .option('-c, --config <config>', 'RouteCodex configuration file path')
  .option('--claude-path <path>', 'Path to Claude Code executable', 'claude')
  .option('--cwd <dir>', 'Working directory for Claude Code (defaults to current shell cwd)')
  .option('--model <model>', 'Model to use with Claude Code')
  .option('--profile <profile>', 'Claude Code profile to use')
  .option('--ensure-server', 'Ensure RouteCodex server is running before launching Claude')
  .argument('[extraArgs...]', 'Additional args to pass through to Claude')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (...cmdArgs) => {
    const options = cmdArgs.pop() as any; // Commander passes options as last arg
    const extraArgsFromCommander: string[] = Array.isArray(cmdArgs[0]) ? (cmdArgs[0] as string[]) : [];
    const spinner = ora('Preparing Claude Code with RouteCodex...').start();

    try {
      // Resolve configuration and determine port
      let configPath = options.config;
      if (!configPath) {
        configPath = path.join(homedir(), '.routecodex', 'config.json');
      }

      let actualPort = options.port ? parseInt(options.port, 10) : null;
      let actualHost = options.host;

      // If no explicit port provided, try to read from config file
      if (!actualPort && fs.existsSync(configPath)) {
        try {
          const configContent = fs.readFileSync(configPath, 'utf8');
          const config = JSON.parse(configContent);
          actualPort = (config?.httpserver?.port ?? config?.server?.port ?? config?.port) || null;
          actualHost = (config?.httpserver?.host || config?.server?.host || config?.host || actualHost);
        } catch (error) {
          spinner.warn('Failed to read configuration file, using defaults');
        }
      }

      // Require explicit port if not provided via flag or config
      if (!actualPort) {
        spinner.fail('Invalid or missing port configuration for RouteCodex server');
        logger.error('Please set httpserver.port in your configuration (e.g., ~/.routecodex/config.json)');
        process.exit(1);
      }

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
        const serverUrl = `http://${connectHost}:${actualPort}`;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const response = await fetch(`${serverUrl}/ready`, { signal: controller.signal, method: 'GET' } as any);
          clearTimeout(timeoutId);
          if (!response.ok) {throw new Error('Server not ready');}
          const j = await response.json().catch(() => ({}));
          if (j?.status !== 'ready') {throw new Error('Server reported not_ready');}
          spinner.succeed('RouteCodex server is ready');
        } catch (error) {
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
              const res = await fetch(`${serverUrl}/ready`, { method: 'GET' } as any);
              if (res.ok) {
                const jr = await res.json().catch(() => ({}));
                if (jr?.status === 'ready') { ready = true; break; }
              }
            } catch { /* ignore */ }
          }
          if (ready) {spinner.succeed('RouteCodex server is ready');}
          else {spinner.warn('RouteCodex server may not be fully ready, continuing...');}
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
      const anthropicBase = `http://${resolvedBaseHost}:${actualPort}`;
      const currentCwd = (() => {
        try {
          const d = options.cwd ? String(options.cwd) : process.cwd();
          const resolved = path.resolve(d);
          if (fs.existsSync(resolved)) return resolved;
        } catch {}
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
        ANTHROPIC_API_KEY: 'rcc-proxy-key'
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
        const knownOpts = new Set(['-p','--port','-h','--host','-c','--config','--claude-path','--model','--profile','--ensure-server']);
        const requireValue = new Set(['-p','--port','-h','--host','-c','--config','--claude-path','--model','--profile']);
        const passThrough: string[] = [];
        for (let i = 0; i < tail.length; i++) {
          const tok = tail[i];
          if (knownOpts.has(tok)) { if (requireValue.has(tok)) i++; continue; }
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
      } catch { /* ignore passthrough errors */ }

      // Launch Claude Code
      const { spawn } = await import('child_process');
      const claudeBin = ((): string => {
        try {
          const v = String(options?.claudePath || '').trim();
          if (v) return v;
        } catch {}
        const envPath = String(process.env.CLAUDE_PATH || '').trim();
        return envPath || 'claude';
      })();
      const claudeProcess = spawn(claudeBin, claudeArgs, {
        stdio: 'inherit',
        env: claudeEnv,
        cwd: currentCwd
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

      claudeProcess.on('exit', (code, signal) => {
        if (signal) {
          process.exit(0);
        } else {
          process.exit(code ?? 0);
        }
      });

      // Keep process alive
      await new Promise(() => {});

    } catch (error) {
      spinner.fail('Failed to launch Claude Code');
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Env command - Print env exports for Anthropic proxy
program
  .command('env')
  .description('Print environment exports for Anthropic tools to use RouteCodex proxy')
  .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
  .option('-h, --host <host>', 'RouteCodex server host')
  .option('-c, --config <config>', 'RouteCodex configuration file path')
  .option('--json', 'Output JSON instead of shell exports')
  .action(async (options) => {
    try {
      let configPath = options.config as string | undefined;
      if (!configPath) { configPath = path.join(homedir(), '.routecodex', 'config.json'); }

      let host = (options.host as string | undefined) || undefined;
      let port = options.port ? parseInt(String(options.port), 10) : NaN;

      if (!Number.isFinite(port) || port <= 0) {
        if (fs.existsSync(configPath)) {
          try {
            const raw = fs.readFileSync(configPath, 'utf8');
            const cfg = JSON.parse(raw);
            port = (cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port) || port;
            host = (cfg?.httpserver?.host || cfg?.server?.host || cfg?.host || host);
          } catch { /* ignore */ }
        }
      }

      if (!Number.isFinite(port) || port <= 0) {
        throw new Error('Missing port. Set via --port or config file');
      }

      const norm = (h: string | undefined): string => {
        const v = String(h || '').toLowerCase();
        if (v === '0.0.0.0' || v === '::' || v === '::1' || v === 'localhost') {return LOCAL_HOSTS.IPV4;}
        return h || LOCAL_HOSTS.IPV4;
      };
      const resolvedHost = norm(host);
      const base = `http://${resolvedHost}:${port}`;

      if (options.json) {
        const out = {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_API_URL: base,
          ANTHROPIC_API_KEY: 'rcc-proxy-key',
          UNSET: ['ANTHROPIC_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
        };
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`export ANTHROPIC_BASE_URL=${base}`);
        console.log(`export ANTHROPIC_API_URL=${base}`);
        console.log(`export ANTHROPIC_API_KEY=rcc-proxy-key`);
        // Ensure conflicting tokens are not picked up by client tools
        console.log('unset ANTHROPIC_TOKEN');
        console.log('unset ANTHROPIC_AUTH_TOKEN');
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Start command
program
  .command('start')
  .description('Start the RouteCodex server')
  .option('-c, --config <config>', 'Configuration file path')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--codex', 'Use Codex system prompt (tools unchanged)')
  .option('--claude', 'Use Claude system prompt (tools unchanged)')
  .option('--restart', 'Restart if an instance is already running')
  .option('--exclusive', 'Always take over the port (kill existing listeners)')
  .action(async (options) => {
    const spinner = ora('Starting RouteCodex server...').start();

    try {
      // Validate system prompt replacement flags
      try {
        if (options.codex && options.claude) {
          spinner.fail('Flags --codex and --claude are mutually exclusive');
          process.exit(1);
        }
        if (options.codex) {
          process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
        } else if (options.claude) {
          process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'claude';
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

      // Load and validate configuration
      let config;
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent);
      } catch (error) {
        spinner.fail('Failed to parse configuration file');
        logger.error(`Invalid JSON in configuration file: ${configPath}`);
        process.exit(1);
      }

      // Validate required configuration fields (prefer httpserver.port; allow top-level port)
      const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
      if (!port || typeof port !== 'number' || port <= 0) {
        spinner.fail('Invalid or missing port configuration');
        logger.error('Please set a valid port (httpserver.port or top-level port) in your configuration');
        process.exit(1);
      }

      const resolvedPort = port;

      // Ensure port state aligns with requested behavior (always take over to avoid duplicates)
      await ensurePortAvailable(resolvedPort, spinner, { restart: true });

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
      const args: string[] = [serverEntry, modulesConfigPath];

      const childProc = spawn(nodeBin, args, { stdio: 'inherit', env });
      // Persist child pid for out-of-band stop diagnostics
      try {
        const pidFile = path.join(homedir(), '.routecodex', 'server.cli.pid');
        fs.writeFileSync(pidFile, String(childProc.pid ?? ''), 'utf8');
      } catch (error) { /* ignore */ }

      const host = (config?.httpserver?.host || config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST);
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
        try { if (childProc.pid) { process.kill(-childProc.pid, sig); } } catch (error) { /* ignore */ }
        // 3) Wait briefly; if still listening, try SIGTERM/SIGKILL by port
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) {break;}
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        if (remain.length) {
          for (const pid of remain) {
            try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
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
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
          }
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
      await new Promise(() => {});

    } catch (error) {
      spinner.fail('Failed to start server');
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Config command
program
  .command('config')
  .description('Configuration management')
  .argument('<action>', 'Action to perform (show, edit, validate, init)')
  .option('-c, --config <config>', 'Configuration file path')
  .option('-t, --template <template>', 'Configuration template (default, lmstudio, oauth)')
  .option('-f, --force', 'Force overwrite existing configuration')
  .action(async (action, options) => {
    try {
      const configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');

      switch (action) {
        case 'init':
          await initializeConfig(configPath, options.template, options.force);
          break;

        case 'show':
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log(JSON.stringify(config, null, 2));
          } else {
            logger.error('Configuration file not found');
          }
          break;

        case 'edit': {
          const editor = process.env.EDITOR || 'nano';
          const { spawn } = await import('child_process');
          spawn(editor, [configPath], { stdio: 'inherit' });
          break;
        }

        case 'validate': {
          if (fs.existsSync(configPath)) {
            try {
              JSON.parse(fs.readFileSync(configPath, 'utf8'));
              logger.success('Configuration is valid');
            } catch (error) {
              logger.error(`Configuration is invalid: ${  error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            logger.error('Configuration file not found');
          }
          break;
        }

        default:
          logger.error('Unknown action. Use: show, edit, validate, init');
      }
    } catch (error) {
      logger.error(`Config command failed: ${  error instanceof Error ? error.message : String(error)}`);
    }
  });

// Initialize configuration helper function
async function initializeConfig(configPath: string, template?: string, force: boolean = false) {
  const spinner = ora('Initializing configuration...').start();

  try {
    // Create config directory if it doesn't exist
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Check if config already exists
    if (fs.existsSync(configPath) && !force) {
      spinner.warn('Configuration file already exists');
      spinner.info('Use --force flag to overwrite or choose a different path');
      return;
    }

    // Load template
    let templateConfig: TemplateConfig | undefined;

    switch (template) {
      case 'lmstudio':
        templateConfig = {
          server: {
            port: DEFAULT_CONFIG.PORT,
            host: LOCAL_HOSTS.LOCALHOST
          },
          logging: {
            level: "info"
          },
          providers: {
            lmstudio: {
              type: "lmstudio",
              baseUrl: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.LM_STUDIO_PORT}`,
              apiKey: "${LM_STUDIO_API_KEY:-}",
              models: {
                "gpt-oss-20b-mlx": {
                  maxTokens: 8192,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                },
                "qwen2.5-7b-instruct": {
                  maxTokens: 32768,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                }
              },
              timeout: 60000,
              retryAttempts: 3
            }
          },
          routing: {
            default: "lmstudio",
            models: {
              "gpt-4": "gpt-oss-20b-mlx",
              "gpt-4-turbo": "gpt-oss-20b-mlx",
              "gpt-3.5-turbo": "gpt-oss-20b-mlx",
              "claude-3-haiku": "qwen2.5-7b-instruct",
              "claude-3-sonnet": "gpt-oss-20b-mlx"
            }
          },
          features: {
            tools: {
              enabled: true,
              maxTools: 10
            },
            streaming: {
              enabled: true,
              chunkSize: 1024
            },
            oauth: {
              enabled: true,
              providers: ["qwen", "iflow"]
            }
          }
        };
        break;

      case 'oauth':
        templateConfig = {
          server: {
            port: DEFAULT_CONFIG.PORT,
            host: LOCAL_HOSTS.LOCALHOST
          },
          logging: {
            level: "info"
          },
          providers: {
            qwen: {
              type: "qwen-provider",
              baseUrl: "https://chat.qwen.ai",
              oauth: {
                clientId: "f0304373b74a44d2b584a3fb70ca9e56",
                deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
                tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
                scopes: ["openid", "profile", "email", "model.completion"]
              },
              models: {
                "qwen3-coder-plus": {
                  maxTokens: 32768,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                }
              }
            },
            iflow: {
              type: "iflow-http",
              baseUrl: "https://api.iflow.cn/v1",
              oauth: {
                clientId: "10009311001",
                clientSecret: "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW",
                authUrl: "https://iflow.cn/oauth",
                tokenUrl: "https://iflow.cn/oauth/token",
                deviceCodeUrl: "https://iflow.cn/oauth/device/code",
                scopes: ["openid", "profile", "api"]
              },
              models: {
                "iflow-pro": {
                  maxTokens: 32768,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                }
              }
            }
          },
          routing: {
            default: "qwen",
            models: {
              "gpt-4": "qwen3-coder-plus",
              "gpt-3.5-turbo": "qwen3-coder-plus",
              "claude-3-haiku": "qwen3-coder-plus",
              "claude-3-sonnet": "iflow-pro"
            }
          },
          features: {
            tools: {
              enabled: true,
              maxTools: 10
            },
            streaming: {
              enabled: true,
              chunkSize: 1024
            },
            oauth: {
              enabled: true,
              autoRefresh: true,
              sharedCredentials: true
            }
          }
        };
        break;

      default:
        templateConfig = {
          server: {
            port: DEFAULT_CONFIG.PORT,
            host: LOCAL_HOSTS.LOCALHOST
          },
          logging: {
            level: "info"
          },
          providers: {
            openai: {
              type: "openai",
              apiKey: "${OPENAI_API_KEY}",
              baseUrl: API_ENDPOINTS.OPENAI,
              models: {
                "gpt-4": {
                  maxTokens: 8192,
                  temperature: 0.7
                },
                "gpt-3.5-turbo": {
                  maxTokens: 4096,
                  temperature: 0.7
                }
              }
            }
          },
          routing: {
            default: "openai"
          },
          features: {
            tools: {
              enabled: true,
              maxTools: 10
            },
            streaming: {
              enabled: true,
              chunkSize: 1024
            }
          }
        };
    }

    // Write configuration file
    fs.writeFileSync(configPath, JSON.stringify(templateConfig, null, 2));

    spinner.succeed(`Configuration initialized: ${configPath}`);
    logger.info(`Template used: ${template || 'default'}`);
    logger.info('You can now start the server with: rcc start');

  } catch (error) {
    spinner.fail('Failed to initialize configuration');
    logger.error(`Initialization failed: ${  error instanceof Error ? error.message : String(error)}`);
  }
}

// Stop command
program
  .command('stop')
  .description('Stop the RouteCodex server')
  .action(async (options) => {
    const spinner = ora('Stopping RouteCodex server...').start();
    try {
      // Resolve config path and port
      const configPath = path.join(homedir(), '.routecodex', 'config.json');

      // Check if config exists
      if (!fs.existsSync(configPath)) {
        spinner.fail(`Configuration file not found: ${configPath}`);
        logger.error('Cannot determine server port without configuration file');
        logger.info('Please create a configuration file first:');
        logger.info('  rcc config init');
        process.exit(1);
      }

      // Load configuration to get port
      let config;
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent);
      } catch (error) {
        spinner.fail('Failed to parse configuration file');
        logger.error(`Invalid JSON in configuration file: ${configPath}`);
        process.exit(1);
      }

      const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
      if (!port || typeof port !== 'number' || port <= 0) {
        spinner.fail('Invalid or missing port configuration');
        logger.error('Configuration file must specify a valid port number');
        process.exit(1);
      }

      const resolvedPort = port;

      const pids = findListeningPids(resolvedPort);
      if (!pids.length) {
        spinner.succeed(`No server listening on ${resolvedPort}.`);
        return;
      }
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (findListeningPids(resolvedPort).length === 0) {
          spinner.succeed(`Stopped server on ${resolvedPort}.`);
          return;
        }
        await sleep(100);
      }
      const remain = findListeningPids(resolvedPort);
      if (remain.length) {
        for (const pid of remain) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
      }
      spinner.succeed(`Force stopped server on ${resolvedPort}.`);
    } catch (e) {
      spinner.fail(`Failed to stop: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// Restart command (stop + start with same environment)
program
  .command('restart')
  .description('Restart the RouteCodex server')
  .option('-c, --config <config>', 'Configuration file path')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--codex', 'Use Codex system prompt (tools unchanged)')
  .option('--claude', 'Use Claude system prompt (tools unchanged)')
  .action(async (options) => {
    const spinner = ora('Restarting RouteCodex server...').start();
    try {
      // Resolve config path
      const configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');

      // Check if config exists
      if (!fs.existsSync(configPath)) {
        spinner.fail(`Configuration file not found: ${configPath}`);
        logger.error('Cannot determine server port without configuration file');
        logger.info('Please create a configuration file first:');
        logger.info('  rcc config init');
        process.exit(1);
      }

      // Load configuration to get port
      let config;
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent);
      } catch (error) {
        spinner.fail('Failed to parse configuration file');
        logger.error(`Invalid JSON in configuration file: ${configPath}`);
        process.exit(1);
      }

      const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
      if (!port || typeof port !== 'number' || port <= 0) {
        spinner.fail('Invalid or missing port configuration');
        logger.error('Configuration file must specify a valid port number');
        process.exit(1);
      }

      const resolvedPort = port;

      // Stop current instance (if any)
      const pids = findListeningPids(resolvedPort);
      if (pids.length) {
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) {break;}
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        for (const pid of remain) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
      }

      spinner.text = 'Starting RouteCodex server...';

      // Delegate to start command behavior with --restart semantics
      const nodeBin = process.execPath;
      const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
      const { spawn } = await import('child_process');

      // Prompt source flags
      if (options.codex && options.claude) {
        spinner.fail('Flags --codex and --claude are mutually exclusive');
        process.exit(1);
      }
      if (options.codex) { process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex'; }
      else if (options.claude) { process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'claude'; }
      else if (!process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE) {
        // Default to Codex system prompt source if not specified
        process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
      }

      const modulesConfigPath = getModulesConfigPath();
      const env = { ...process.env } as NodeJS.ProcessEnv;
      const args: string[] = [serverEntry, modulesConfigPath];
      const child = spawn(nodeBin, args, { stdio: 'inherit', env });
      try { fs.writeFileSync(path.join(homedir(), '.routecodex', 'server.cli.pid'), String(child.pid ?? ''), 'utf8'); } catch (error) { /* ignore */ }

      const host = (config?.httpserver?.host || config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST);
      spinner.succeed(`RouteCodex server restarting on ${host}:${resolvedPort}`);
      logger.info(`Server will run on port: ${resolvedPort}`);
      logger.info('Press Ctrl+C to stop the server');

      const shutdown = async (sig: NodeJS.Signals) => {
        try { await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {}); } catch (error) { /* ignore */ }
        try { child.kill(sig); } catch (error) { /* ignore */ }
        try { if (child.pid) { process.kill(-child.pid, sig); } } catch (error) { /* ignore */ }
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) {break;}
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        for (const pid of remain) { try { process.kill(pid, 'SIGTERM'); } catch (error) { /* ignore */ } }
        const killDeadline = Date.now() + 1500;
        while (Date.now() < killDeadline) {
          if (findListeningPids(resolvedPort).length === 0) {break;}
          await sleep(100);
        }
        const still = findListeningPids(resolvedPort);
        for (const pid of still) { try { process.kill(pid, 'SIGKILL'); } catch (error) { /* ignore */ } }
        // Ensure parent exits in any case
        try { process.exit(0); } catch (error) { /* ignore */ }
      };
      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

      // Fallback keypress handler for restart mode as well
      const cleanupKeypress2 = setupKeypress(() => { void shutdown('SIGINT'); });

      child.on('exit', (code, signal) => {
        try { cleanupKeypress2(); } catch { /* ignore */ }
        if (signal) {process.exit(0);}
        else {process.exit(code ?? 0);}
      });

      await new Promise(() => {});
    } catch (e) {
      spinner.fail(`Failed to restart: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show server status')
  .option('-j, --json', 'Output in JSON format')
  .action(async (options) => {
    try {
      // Resolve config path and get configuration
      const configPath = path.join(homedir(), '.routecodex', 'config.json');

      // Check if config exists
      if (!fs.existsSync(configPath)) {
        logger.error('Configuration file not found');
        logger.info('Please create a configuration file first:');
        logger.info('  rcc config init');
        if (options.json) {
          console.log(JSON.stringify({ error: 'Configuration file not found' }, null, 2));
        }
        return;
      }

      let port: number;
      let host: string;

      // Load configuration to get port and host
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configContent);

        port = config?.port || config?.server?.port;
        host = config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST;

        if (!port || typeof port !== 'number' || port <= 0) {
          const errorMsg = 'Invalid or missing port configuration in configuration file';
          logger.error(errorMsg);
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2));
          }
          return;
        }
      } catch (error) {
        const errorMsg = `Failed to parse configuration file: ${configPath}`;
        logger.error(errorMsg);
        if (options.json) {
          console.log(JSON.stringify({ error: errorMsg }, null, 2));
        }
        return;
      }

      // Check if server is running by trying to connect (HTTP)
      const { get } = await import('http');

      const checkServer = (port: number, host: string): Promise<HealthCheckResult> => {
        return new Promise((resolve) => {
          const req = get({
            hostname: host,
            port: port,
            path: '/health',
            method: 'GET',
            timeout: 5000
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const health = JSON.parse(data);
                // Ensure required fields in case health payload differs
                resolve({
                  status: health?.status || 'unknown',
                  port,
                  host
                });
              } catch {
                resolve({ status: 'unknown', port, host });
              }
            });
          });

          req.on('error', () => {
            resolve({ status: 'stopped', port, host });
          });

          req.on('timeout', () => {
            req.destroy();
            resolve({ status: 'timeout', port, host });
          });

          req.end();
        });
      };

      const status = await checkServer(port, host);

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        switch (status.status) {
          case 'running':
            logger.success(`Server is running on ${host}:${port}`);
            break;
          case 'stopped':
            logger.error('Server is not running');
            break;
          case 'error':
            logger.error('Server is in error state');
            break;
          default:
            logger.warning('Server status unknown');
        }
      }
    } catch (error) {
      logger.error(`Status check failed: ${  error instanceof Error ? error.message : String(error)}`);
    }
  });

// Clean command: purge local capture and debug data for fresh runs
program
  .command('clean')
  .description('Clean captured data and debug logs')
  .option('-y, --yes', 'Confirm deletion without prompt')
  .option('--what <targets>', 'Targets to clean: captures,logs,all', 'all')
  .action(async (options) => {
    const confirm = Boolean(options.yes);
    const what = String(options.what || 'all');
    if (!confirm) {
      logger.warning("Add --yes to confirm deletion.");
      logger.info("Example: rcc clean --yes --what all");
      return;
    }
    const home = homedir();
    const targets: Array<{ path: string; label: string }>= [];
    if (what === 'captures' || what === 'all') {
      targets.push({ path: path.join(home, '.routecodex', 'codex-samples'), label: 'captures' });
    }
    if (what === 'logs' || what === 'all') {
      targets.push({ path: path.join(process.cwd(), 'debug-logs'), label: 'debug-logs' });
      targets.push({ path: path.join(home, '.routecodex', 'logs'), label: 'user-logs' });
    }
    let removedAny = false;
    for (const t of targets) {
      try {
        if (fs.existsSync(t.path)) {
          const entries = fs.readdirSync(t.path);
          for (const name of entries) {
            const p = path.join(t.path, name);
            try {
              // Recursively remove files/folders
              fs.rmSync(p, { recursive: true, force: true });
              removedAny = true;
            } catch (e) {
              logger.warning(`Failed to remove ${p}: ${(e as Error).message}`);
            }
          }
          logger.success(`Cleared ${t.label} at ${t.path}`);
        }
      } catch (e) {
        logger.warning(`Unable to access ${t.label} at ${t.path}: ${(e as Error).message}`);
      }
    }
    if (!removedAny) {
      logger.info('Nothing to clean.');
    }
  });

// Import commands at top level
// offline-log CLI temporarily disabled to simplify build

// simple-log config helper removed

// Add commands
// dry-run commands removed
// offline-log command disabled
// simple-log command removed

// Examples command
program
  .command('examples')
  .description('Show usage examples')
  .action(() => {
    console.log(chalk.cyan('RouteCodex Usage Examples'));
    console.log('='.repeat(40));
    console.log('');

    console.log(chalk.yellow('1. Initialize Configuration:'));
    console.log('  # Create default configuration');
    console.log('  rcc config init');
    console.log('');
    console.log('  # Create LMStudio configuration');
    console.log('  rcc config init --template lmstudio');
    console.log('');
    console.log('  # Create OAuth configuration');
    console.log('  rcc config init --template oauth');
    console.log('');

    console.log(chalk.yellow('2. Start Server:'));
    console.log('  # Start with default config');
    console.log('  rcc start');
    console.log('');
    console.log('  # Start with custom config');
    console.log('  rcc start --config ./config/lmstudio-config.json');
    console.log('');
    console.log('  # Note: Port must be specified in configuration file');
    console.log('  # Server will not start without valid port configuration');
    console.log('');

    console.log(chalk.yellow('3. Launch Claude Code:'));
    console.log('  # Launch Claude Code with automatic server start');
    console.log('  rcc code --ensure-server');
    console.log('');
    console.log('  # Launch Claude Code with specific model');
    console.log('  rcc code --model claude-3-haiku');
    console.log('');
    console.log('  # Launch Claude Code with custom profile');
    console.log('  rcc code --profile my-profile');
    console.log('');

    console.log(chalk.yellow('4. Configuration Management:'));
    console.log('  # Show current configuration');
    console.log('  rcc config show');
    console.log('');
    console.log('  # Edit configuration');
    console.log('  rcc config edit');
    console.log('');
    console.log('  # Validate configuration');
    console.log('  rcc config validate');
    console.log('');

    // Dry-Run examples removed

    console.log(chalk.yellow('6. Environment Variables:'));
    console.log('  # Set LM Studio API Key');
    console.log('  export LM_STUDIO_API_KEY="your-api-key"');
    console.log('');
    console.log('  # Set OpenAI API Key');
    console.log('  export OPENAI_API_KEY="your-api-key"');
    console.log('');

    console.log(chalk.yellow('7. Testing:'));
    console.log('  # Test with curl');
    console.log('  curl -X POST http://localhost:5506/v1/chat/completions \\');
    console.log('    -H "Content-Type: application/json" \\');
    console.log('    -H "Authorization: Bearer test-key" \\');
    console.log('    -d \'{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello!"}]}\'');
    console.log('');
  });

function determinePort(configPath: string, fallback: number): number {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    const candidate = config?.server?.port ?? config?.httpserver?.port ?? config?.port;
    const parsed = parseInt(candidate, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // ignore parsing errors and fall back
  }
  return fallback;
}

async function ensurePortAvailable(port: number, parentSpinner: Ora, opts: { restart?: boolean } = {}): Promise<void> {
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
  const stopSpinner = ora(`Port ${port} is in use on 0.0.0.0. Attempting graceful stop...`).start();
  const gracefulTimeout = Number(process.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
  const killTimeout = Number(process.env.ROUTECODEX_KILL_TIMEOUT_MS ?? 3000);
  const pollInterval = 150;

  for (const pid of initialPids) {
    try {
      process.kill(pid, 'SIGTERM');
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
        process.kill(pid, 'SIGKILL');
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
    const result = spawnSync('lsof', ['-tiTCP', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  } catch { /* ignore */ }
  return () => {};
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

// Monitor command group
program
  .command('monitor')
  .description('Monitoring utilities and transparent passthrough')
  .argument('[sub]', 'Subcommand: start | status')
  .option('-c, --config <config>', 'Configuration file path (default: ~/.routecodex/config.json)')
  .action(async (sub: string | undefined, options) => {
    const userCfgPath = options.config || path.join(homedir(), '.routecodex', 'config.json');

    const ensureMonitorJsonForCodexFc = () => {
      // Read ~/.codex/config.toml to discover fc base_url and env_key
      try {
        const codexPath = path.join(homedir(), '.codex', 'config.toml');
        if (!fs.existsSync(codexPath)) {return { ok: false };}
        const txt = fs.readFileSync(codexPath, 'utf8');
        // crude scan for [model_providers.fc] block
        const lines = txt.split(/\r?\n/);
        let inFc = false; let baseUrl: string | null = null; let envKey: string | null = null;
        for (const raw of lines) {
          const line = raw.trim();
          if (/^\[.*\]$/.test(line)) {
            inFc = /^\[\s*model_providers\.fc\s*\]$/.test(line);
            continue;
          }
          if (!inFc) {continue;}
          const m1 = line.match(/^base_url\s*=\s*"([^"]+)"/);
          if (m1) {baseUrl = m1[1];}
          const m2 = line.match(/^env_key\s*=\s*"([^"]+)"/);
          if (m2) {envKey = m2[1];}
        }
        if (!baseUrl) {return { ok: false };}
        // Write ~/.routecodex/monitor.json
        const monDir = path.join(homedir(), '.routecodex');
        try { fs.mkdirSync(monDir, { recursive: true }); } catch {}
        const monPath = path.join(monDir, 'monitor.json');
        let j: any = {};
        try { j = JSON.parse(fs.readFileSync(monPath, 'utf8')); } catch { j = {}; }
        // Use passive A/B mode by default so live responses stay local,
        // while upstream is invoked side-by-side for comparison.
        j.mode = 'passive';
        j.transparent = j.transparent || {};
        j.transparent.enabled = true;
        j.transparent.defaultUpstream = 'openai';
        j.transparent.endpoints = j.transparent.endpoints || {};
        j.transparent.endpoints.openai = baseUrl;
        j.transparent.headerAllowlist = j.transparent.headerAllowlist || ['accept','content-type','anthropic-version','x-*'];
        j.transparent.timeoutMs = typeof j.transparent.timeoutMs === 'number' ? j.transparent.timeoutMs : 30000;
        j.transparent.preferClientHeaders = (j.transparent.preferClientHeaders !== false);
        // Prefer Responses wire and enforce upstream model id if unset
        if (!j.transparent.wireApi) { j.transparent.wireApi = 'responses'; }
        // Provide a safe default model mapping for upstream that only supports gpt-5-codex
        if (!j.transparent.modelMapping || typeof j.transparent.modelMapping !== 'object') {
          // Do not inject default GLM mappings. Leave empty by default.
          j.transparent.modelMapping = {} as any;
        }
        // auth: reference env key if provided, else FC_API_KEY
        const envRef = envKey && /^[A-Z0-9_]+$/.test(envKey) ? envKey : 'FC_API_KEY';
        j.transparent.auth = j.transparent.auth || {};
        j.transparent.auth.openai = `env:${envRef}`;
        fs.writeFileSync(monPath, JSON.stringify(j, null, 2), 'utf8');
        return { ok: true, monPath, baseUrl, envKey: envRef };
      } catch (e) {
        return { ok: false, error: (e as any)?.message || String(e) };
      }
    };

    const showStatus = () => {
      try {
        const monPath = path.join(homedir(), '.routecodex', 'monitor.json');
        let j: any = null;
        if (fs.existsSync(monPath)) { try { j = JSON.parse(fs.readFileSync(monPath, 'utf8')); } catch { j = null; } }
        console.log(chalk.cyan('Monitoring status:'));
        console.log(`  monitor.json : ${fs.existsSync(monPath) ? monPath : '(missing)'}`);
        const mode = j?.mode || (j?.transparent?.enabled ? 'transparent' : 'off');
        console.log(`  mode         : ${mode}`);
        console.log(`  upstream     : ${j?.transparent?.endpoints?.openai || '(unset)'}`);
        const auth = j?.transparent?.auth?.openai || '(unset)';
        console.log(`  auth         : ${auth}`);
      } catch (e) {
        console.error(chalk.red('Failed to read monitor status:'), (e as Error)?.message || e);
        process.exit(2);
      }
    };

    if (!sub) { sub = 'start'; }
    if (sub === 'status') {
      return showStatus();
    }

    if (sub === 'start') {
      const spinner = ora('Starting RouteCodex in monitor mode...').start();
      try {
        const filled = ensureMonitorJsonForCodexFc();
        if (filled.ok) {
          spinner.info(`monitor.json updated for fc upstream: ${filled.baseUrl}`);
          if (!process.env[filled.envKey!]) {
            console.log(chalk.yellow(`Hint: export ${filled.envKey}='<your_fc_api_key>'`));
          }
        } else {
          spinner.info('monitor.json not updated from codex fc (no ~/.codex/config.toml or missing fc block). Using existing monitor.json if present.');
        }

        // Load config and resolve port
        if (!fs.existsSync(userCfgPath)) {
          spinner.fail(`Configuration file not found: ${userCfgPath}`);
          console.log(`Create minimal config, e.g.: {"httpserver":{"host":"${LOCAL_HOSTS.IPV4}","port":${DEFAULT_CONFIG.PORT}}}`);
          process.exit(1);
        }
        const cfg = JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
        const port = (cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port);
        if (!port || typeof port !== 'number' || port <= 0) {
          spinner.fail('Invalid or missing port configuration');
          process.exit(1);
        }

        // Free port if requested via --restart equivalent (optional)
        await ensurePortAvailable(port, spinner, { restart: true });

        const nodeBin = process.execPath;
        const serverEntry = path.resolve(__dirname, 'index.js');
        const modulesConfigPath = path.resolve(__dirname, '../config/modules.json');
        const { spawn } = await import('child_process');
        const env = { ...process.env } as NodeJS.ProcessEnv;
        env.ROUTECODEX_CONFIG = userCfgPath;
        // Enable runtime monitoring in passive A/B mode by default
        env.ROUTECODEX_MONITOR_ENABLED = '1';
        env.ROUTECODEX_MONITOR_AB = '1';
        const child = spawn(nodeBin, [serverEntry, modulesConfigPath], { stdio: 'inherit', env });
        spinner.succeed('RouteCodex (monitor mode) starting');
        console.log(`Config: ${userCfgPath}`);
        console.log('Press Ctrl+C to stop');

        const shutdown = async (sig: NodeJS.Signals) => {
          try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' } as any).catch(() => null); } catch {}
          try { child.kill(sig); } catch {}
          process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown('SIGINT'); });
        process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
        await new Promise(() => {});
      } catch (e) {
        spinner.fail('Failed to start monitor mode');
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      return;
    }

    console.error(chalk.red('Unknown subcommand. Use: rcc monitor start | rcc monitor status'));
    process.exit(2);
  });

// Port utilities: doctor
program
  .command('port')
  .description('Port utilities (doctor)')
  .argument('<sub>', 'Subcommand: doctor')
  .argument('[port]', 'Port number (e.g., ${DEFAULT_CONFIG.PORT})')
  .option('--kill', 'Kill all listeners on the port')
  .action(async (sub: string, portArg: string | undefined, opts: { kill?: boolean }) => {
    if ((sub || '').toLowerCase() !== 'doctor') {
      console.error(chalk.red("Unknown subcommand. Use: rcc port doctor [port] [--kill]"));
      process.exit(2);
    }
    const spinner = ora('Inspecting port...').start();
    try {
      let port = Number(portArg || 0);
      if (!Number.isFinite(port) || port <= 0) {
        // fallback to user config
        const cfgPath = path.join(homedir(), '.routecodex', 'config.json');
        if (fs.existsSync(cfgPath)) {
          try {
            const raw = fs.readFileSync(cfgPath, 'utf8');
            const cfg = JSON.parse(raw);
            port = (cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port) || port;
          } catch { /* ignore */ }
        }
      }
      if (!Number.isFinite(port) || port <= 0) {
        spinner.fail('Missing port. Provide an explicit port or set it in ~/.routecodex/config.json');
        process.exit(1);
      }

      const pids = findListeningPids(port);
      spinner.stop();
      console.log(chalk.cyan(`Port ${port} listeners:`));
      if (!pids.length) {
        console.log('  (none)');
      } else {
        for (const pid of pids) {
          let cmd = '';
          try { cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim(); } catch {}
          const origin = /node\s+.*routecodex-worktree/.test(cmd) ? 'local-dev' : (/node\s+.*lib\/node_modules\/routecodex/.test(cmd) ? 'global' : 'unknown');
          console.log(`  PID ${pid} [${origin}] ${cmd}`);
        }
      }

      if (opts.kill && pids.length) {
        const ksp = ora(`Killing ${pids.length} listener(s) on ${port}...`).start();
        for (const pid of pids) {
          try { process.kill(pid, 'SIGKILL'); } catch (e) { ksp.warn(`Failed to kill ${pid}: ${(e as Error).message}`); }
        }
        // brief wait
        await sleep(300);
        const remain = findListeningPids(port);
        if (remain.length) {
          ksp.fail(`Some listeners remain: ${remain.join(', ')}`);
          process.exit(1);
        }
        ksp.succeed(`Port ${port} is now free.`);
      }
    } catch (e) {
      spinner.fail('Port inspection failed');
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

// Parse command line arguments (must be last)
program.parse();
