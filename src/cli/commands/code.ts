import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';

type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

export type CodeCommandOptions = {
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

export type CodeCommandContext = {
  isDevPackage: boolean;
  isWindows: boolean;
  defaultDevPort: number;
  nodeBin: string;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  env: NodeJS.ProcessEnv;
  rawArgv: string[];
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  homedir: () => string;
  cwd?: () => string;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  getModulesConfigPath: () => string;
  resolveServerEntryPath: () => string;
  waitForever: () => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, cb: () => void) => void;
  exit: (code: number) => never;
};

function parseServerUrl(
  raw: string
): { protocol: 'http' | 'https'; host: string; port: number | null; basePath: string } {
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
}

function readConfigApiKey(fsImpl: typeof fs, configPath: string): string | null {
  try {
    if (!configPath || !fsImpl.existsSync(configPath)) {
      return null;
    }
    const txt = fsImpl.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(txt);
    const direct = cfg?.httpserver?.apikey ?? cfg?.modules?.httpserver?.config?.apikey ?? cfg?.server?.apikey;
    const value = typeof direct === 'string' ? direct.trim() : '';
    return value ? value : null;
  } catch {
    return null;
  }
}

function normalizeConnectHost(host: string): string {
  const v = String(host || '').toLowerCase();
  if (v === '0.0.0.0') return LOCAL_HOSTS.IPV4;
  if (v === '::' || v === '::1' || v === 'localhost') return LOCAL_HOSTS.IPV4;
  return host || LOCAL_HOSTS.IPV4;
}

export function createCodeCommand(program: Command, ctx: CodeCommandContext): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const getCwd = ctx.cwd ?? (() => process.cwd());

  program
    .command('code')
    .description(
      'Launch Claude Code interface with RouteCodex as proxy (args after this command are passed to Claude by default)'
    )
    .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
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
      const spinner = await ctx.createSpinner('Preparing Claude Code with RouteCodex...');

      try {
        let configPath = options.config;
        if (!configPath) {
          configPath = pathImpl.join(ctx.homedir(), '.routecodex', 'config.json');
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
        // - dev package (routecodex): env override, otherwise固定 DEFAULT_DEV_PORT，不读取配置端口
        // - release package (rcc): 按配置/参数解析端口
        if (ctx.isDevPackage) {
          if (!actualPort) {
            const envPort = Number(ctx.env.ROUTECODEX_PORT || ctx.env.RCC_PORT || NaN);
            actualPort = Number.isFinite(envPort) && envPort > 0 ? envPort : ctx.defaultDevPort;
            ctx.logger.info(`Using dev default port ${actualPort} for routecodex code (config ports ignored)`);
          }
        } else {
          if (!actualPort && fsImpl.existsSync(configPath) && !(options.url && String(options.url).trim())) {
            try {
              const configContent = fsImpl.readFileSync(configPath, 'utf8');
              const config = JSON.parse(configContent);
              actualPort = (config?.httpserver?.port ?? config?.server?.port ?? config?.port) || null;
              actualHost = config?.httpserver?.host || config?.server?.host || config?.host || actualHost;
            } catch {
              spinner.warn('Failed to read configuration file, using defaults');
            }
          }
        }

        if (!(options.url && String(options.url).trim()) && !actualPort) {
          spinner.fail('Invalid or missing port configuration for RouteCodex server');
          ctx.logger.error(
            'Please set httpserver.port in your configuration (e.g., ~/.routecodex/config.json) or use --port'
          );
          ctx.exit(1);
        }

        const configuredApiKey =
          (typeof options.apikey === 'string' && options.apikey.trim() ? options.apikey.trim() : null) ??
          (typeof ctx.env.ROUTECODEX_APIKEY === 'string' && ctx.env.ROUTECODEX_APIKEY.trim()
            ? ctx.env.ROUTECODEX_APIKEY.trim()
            : null) ??
          (typeof ctx.env.RCC_APIKEY === 'string' && ctx.env.RCC_APIKEY.trim() ? ctx.env.RCC_APIKEY.trim() : null) ??
          readConfigApiKey(fsImpl, configPath);

        const connectHost = normalizeConnectHost(actualHost);
        const portPart = actualPort ? `:${actualPort}` : '';
        const serverUrl = `${actualProtocol}://${connectHost}${portPart}${actualBasePath}`;

        if (options.ensureServer) {
          spinner.text = 'Checking RouteCodex server status...';
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const headers = configuredApiKey ? { 'x-api-key': configuredApiKey } : undefined;
            const response = await ctx.fetch(`${serverUrl}/ready`, { signal: controller.signal, method: 'GET', headers });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error('Server not ready');
            const j = await response.json().catch(() => ({}));
            if (j?.status !== 'ready') throw new Error('Server reported not_ready');
            spinner.succeed('RouteCodex server is ready');
          } catch (error) {
            if (options.url && String(options.url).trim()) {
              spinner.fail('RouteCodex server is not reachable (ensure-server with --url cannot auto-start)');
              ctx.logger.error(error instanceof Error ? error.message : String(error));
              ctx.exit(1);
            }

            spinner.info('RouteCodex server is not running, starting it...');

            const serverProcess = ctx.spawn(ctx.nodeBin, [ctx.resolveServerEntryPath(), ctx.getModulesConfigPath()], {
              stdio: 'pipe',
              env: { ...ctx.env },
              detached: true
            });
            try {
              serverProcess.unref?.();
            } catch {
              // ignore
            }

            spinner.text = 'Waiting for RouteCodex server to become ready...';
            let ready = false;
            for (let i = 0; i < 30; i++) {
              await ctx.sleep(1000);
              try {
                const headers = configuredApiKey ? { 'x-api-key': configuredApiKey } : undefined;
                const res = await ctx.fetch(`${serverUrl}/ready`, { method: 'GET', headers });
                if (res.ok) {
                  const jr = await res.json().catch(() => ({}));
                  if (jr?.status === 'ready') {
                    ready = true;
                    break;
                  }
                }
              } catch {
                /* ignore */
              }
            }

            if (ready) {
              spinner.succeed('RouteCodex server is ready');
            } else {
              spinner.warn('RouteCodex server may not be fully ready, continuing...');
            }
          }
        }

        spinner.text = 'Launching Claude Code...';

        const resolvedBaseHost = normalizeConnectHost(actualHost);
        const anthropicBase = `${actualProtocol}://${resolvedBaseHost}${portPart}${actualBasePath}`;
        const currentCwd = (() => {
          try {
            const d = options.cwd ? String(options.cwd) : getCwd();
            const resolved = pathImpl.resolve(d);
            if (fsImpl.existsSync(resolved)) {
              return resolved;
            }
          } catch {
            return getCwd();
          }
          return getCwd();
        })();

        const claudeEnv = {
          ...ctx.env,
          PWD: currentCwd,
          RCC_WORKDIR: currentCwd,
          ROUTECODEX_WORKDIR: currentCwd,
          CLAUDE_WORKDIR: currentCwd,
          ANTHROPIC_BASE_URL: anthropicBase,
          ANTHROPIC_API_URL: anthropicBase,
          ANTHROPIC_API_KEY: configuredApiKey || 'rcc-proxy-key'
        } as NodeJS.ProcessEnv;

        try {
          delete (claudeEnv as Record<string, unknown>)['ANTHROPIC_AUTH_TOKEN'];
        } catch {
          /* ignore */
        }
        try {
          delete (claudeEnv as Record<string, unknown>)['ANTHROPIC_TOKEN'];
        } catch {
          /* ignore */
        }

        ctx.logger.info('Unset ANTHROPIC_AUTH_TOKEN/ANTHROPIC_TOKEN for Claude process to avoid conflicts');
        ctx.logger.info(`Setting Anthropic base URL to: ${anthropicBase}`);

        const claudeArgs: string[] = [];
        if (options.model) {
          claudeArgs.push('--model', options.model);
        }
        if (options.profile) {
          claudeArgs.push('--profile', options.profile);
        }

        // passthrough args after `code`
        try {
          const rawArgv = Array.isArray(ctx.rawArgv) ? ctx.rawArgv : [];
          const idxCode = rawArgv.findIndex((a) => a === 'code');
          const afterCode = idxCode >= 0 ? rawArgv.slice(idxCode + 1) : [];
          const sepIndex = afterCode.indexOf('--');
          const tail = sepIndex >= 0 ? afterCode.slice(sepIndex + 1) : afterCode;

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
            if (tok.startsWith('--')) {
              const eq = tok.indexOf('=');
              if (eq > 2) {
                const optName = tok.slice(0, eq);
                if (knownOpts.has(optName)) continue;
              }
            }
            passThrough.push(tok);
          }

          const merged: string[] = [];
          const seen = new Set<string>();
          const pushUnique = (arr: string[]) => {
            for (const t of arr) {
              if (!seen.has(t)) {
                seen.add(t);
                merged.push(t);
              }
            }
          };
          pushUnique(extraArgsFromCommander);
          pushUnique(passThrough);
          if (merged.length) {
            claudeArgs.push(...merged);
          }
        } catch {
          /* ignore passthrough errors */
        }

        const claudeBin = (() => {
          try {
            const v = String(options?.claudePath || '').trim();
            if (v) return v;
          } catch {
            // ignore
          }
          const envPath = String(ctx.env.CLAUDE_PATH || '').trim();
          return envPath || 'claude';
        })();

        const shouldUseShell =
          ctx.isWindows &&
          !pathImpl.extname(claudeBin) &&
          !claudeBin.includes('/') &&
          !claudeBin.includes('\\\\');

        const claudeProcess = ctx.spawn(claudeBin, claudeArgs, {
          stdio: 'inherit',
          env: claudeEnv,
          cwd: currentCwd,
          shell: shouldUseShell
        });

        spinner.succeed('Claude Code launched with RouteCodex proxy');
        ctx.logger.info(`Using RouteCodex server at: http://${resolvedBaseHost}:${actualPort}`);
        ctx.logger.info(`Claude binary: ${claudeBin}`);
        ctx.logger.info(`Working directory for Claude: ${currentCwd}`);
        ctx.logger.info('Press Ctrl+C to exit Claude Code');

        const shutdown = async (sig: NodeJS.Signals) => {
          try {
            claudeProcess.kill(sig);
          } catch {
            /* ignore */
          }
          ctx.exit(0);
        };

        const onSignal = ctx.onSignal ?? ((sig: NodeJS.Signals, cb: () => void) => process.on(sig, cb));
        onSignal('SIGINT', () => {
          void shutdown('SIGINT');
        });
        onSignal('SIGTERM', () => {
          void shutdown('SIGTERM');
        });

        claudeProcess.on('error', (err) => {
          try {
            ctx.logger.error(
              `Failed to launch Claude Code (${claudeBin}): ${err instanceof Error ? err.message : String(err)}`
            );
            if (ctx.isWindows && shouldUseShell) {
              ctx.logger.error('Tip: If Claude is installed via npm, ensure the shim is in PATH (e.g. claude.cmd).');
            }
          } catch {
            /* ignore */
          }
          ctx.exit(1);
        });

        claudeProcess.on('exit', (code, signal) => {
          if (signal) {
            ctx.exit(0);
          } else {
            ctx.exit(code ?? 0);
          }
        });

        await ctx.waitForever();
      } catch (error) {
        spinner.fail('Failed to launch Claude Code');
        ctx.logger.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}
