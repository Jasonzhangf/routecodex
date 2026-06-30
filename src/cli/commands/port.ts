import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import chalk from 'chalk';

import { loadRouteCodexConfig } from '../../config/routecodex-config-loader.js';

type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

type PortCommandOptions = {
  kill?: boolean;
  json?: boolean;
  requestJson?: string;
  metadataJson?: string;
};

export type PortCommandContext = {
  defaultPort: number;
  createSpinner: (text: string) => Promise<Spinner>;
  fetch: typeof fetch;
  findListeningPids: (port: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => never;
};

function parseConfigPort(userConfig: unknown): number {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  };

  const cfg = asRecord(userConfig);
  const httpserver = asRecord(cfg?.httpserver);
  const server = asRecord(cfg?.server);
  const port = httpserver?.port ?? server?.port ?? cfg?.port;
  return typeof port === 'number' && Number.isFinite(port) ? port : NaN;
}

function stringifyJson(value: unknown, pretty: boolean): string {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

async function loadPortDiagnosticsJson(ctx: PortCommandContext, port: number, path: string, body?: unknown): Promise<unknown> {
  const response = await ctx.fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: response.status,
      raw: text
    };
  }
}

export function createPortCommand(program: Command, ctx: PortCommandContext): void {
  program
    .command('port')
    .description('Port utilities (doctor)')
    .argument('<sub>', 'Subcommand: doctor')
    .argument('[port]', `Port number (e.g., ${ctx.defaultPort})`)
    .option('--kill', 'Stop managed RouteCodex server on the port (only stops known managed servers via pid file, refuses to kill unknown listeners)')
    .option('--json', 'Output JSON for diagnostics subcommands')
    .option('--request-json <json>', 'Request JSON for diagnostics dry-run')
    .option('--metadata-json <json>', 'Metadata JSON for diagnostics dry-run')
    .action(async (sub: string, portArg: string | undefined, opts: PortCommandOptions) => {
      const normalizedSub = String(sub || '').toLowerCase();
      if (normalizedSub !== 'doctor' && normalizedSub !== 'status' && normalizedSub !== 'dry-run') {
        ctx.error(chalk.red('Unknown subcommand. Use: rcc port doctor [port] [--kill] | rcc port status [port] [--json] | rcc port dry-run [port] --request-json <json> [--metadata-json <json>]'));
        ctx.exit(2);
      }

      const spinner = await ctx.createSpinner('Inspecting port...');
      try {
        let port = Number(portArg || 0);
        if (!Number.isFinite(port) || port <= 0) {
          try {
            const loaded = await loadRouteCodexConfig();
            const fromCfg = parseConfigPort(loaded.userConfig);
            port = Number.isFinite(fromCfg) && fromCfg > 0 ? fromCfg : port;
          } catch {
            // ignore; fall back to explicit arg requirement
          }
        }

        if (!Number.isFinite(port) || port <= 0) {
          spinner.fail('Missing port. Provide an explicit port or set it in ~/.rcc/config.toml');
          ctx.exit(1);
        }

        if (normalizedSub === 'status') {
          spinner.stop();
          const diagnostics = await loadPortDiagnosticsJson(ctx, port, '/_routecodex/diagnostics/virtual-router/status');
          ctx.log(stringifyJson(diagnostics, !opts?.json));
          return;
        }
        if (normalizedSub === 'dry-run') {
          const requestJson = typeof opts.requestJson === 'string'
            ? opts.requestJson
            : '';
          const metadataJson = typeof opts.metadataJson === 'string'
            ? opts.metadataJson
            : '';
          if (!requestJson.trim()) {
            spinner.fail('Missing --request-json for dry-run');
            ctx.exit(1);
          }
          let request: unknown;
          let metadata: unknown;
          try {
            request = JSON.parse(requestJson);
          } catch (error) {
            spinner.fail('Invalid --request-json');
            ctx.error(error instanceof Error ? error.message : String(error));
            ctx.exit(1);
          }
          try {
            metadata = metadataJson.trim() ? JSON.parse(metadataJson) : {};
          } catch (error) {
            spinner.fail('Invalid --metadata-json');
            ctx.error(error instanceof Error ? error.message : String(error));
            ctx.exit(1);
          }
          spinner.stop();
          const diagnostics = await loadPortDiagnosticsJson(ctx, port, '/_routecodex/diagnostics/virtual-router/dry-run', {
            request,
            metadata
          });
          ctx.log(stringifyJson(diagnostics, !opts?.json));
          return;
        }
        // findListeningPids 返回的是 managed pids（已通过 pid file + command 验证）
        const pids = ctx.findListeningPids(port);
        spinner.stop();
        ctx.log(chalk.cyan(`Port ${port} managed RouteCodex servers:`));

        if (!pids.length) {
          ctx.log('  (none)');
        } else {
          for (const pid of pids) {
            let cmd = '';
            try {
              cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
            } catch {
              cmd = '';
            }
            const origin = /node\s+.*routecodex-worktree/.test(cmd)
              ? 'local-dev'
              : (/node\s+.*lib\/node_modules\/routecodex/.test(cmd) ? 'global' : 'unknown');
            ctx.log(`  PID ${pid} [${origin}] ${cmd}`);
          }
        }

        // --kill 只能杀 managed server，不能杀任意监听者
        // 通过 findListeningPids 已经返回的是 managed pids（已验证是 routecodex）
        if (opts.kill && pids.length) {
          const ksp = await ctx.createSpinner(`Stopping ${pids.length} managed RouteCodex server(s) on ${port}...`);
          for (const pid of pids) {
            try {
              ctx.killPidBestEffort(pid, { force: false });
            } catch (e) {
              ksp.warn(`Failed to stop PID ${pid}: ${(e as Error).message}`);
            }
          }
          await ctx.sleep(500);
          const remain = ctx.findListeningPids(port);
          if (remain.length) {
            ksp.warn(`Graceful stop timed out, forcing SIGKILL to managed PID(s): ${remain.join(', ')}`);
            for (const pid of remain) {
              try {
                ctx.killPidBestEffort(pid, { force: true });
              } catch (e) {
                ksp.warn(`Failed to force-stop PID ${pid}: ${(e as Error).message}`);
              }
            }
            await ctx.sleep(300);
            const stillRemain = ctx.findListeningPids(port);
            if (stillRemain.length) {
              ksp.fail(`Some managed processes remain: ${stillRemain.join(', ')}`);
              ctx.exit(1);
            }
          }
          ksp.succeed(`Port ${port} is now free.`);
        } else if (opts.kill && !pids.length) {
          ctx.log(chalk.yellow('No managed RouteCodex server found on this port. Refusing to kill unknown listeners.'));
          ctx.log(chalk.gray('Use lsof/ps to identify the listener and stop it manually if needed.'));
        }
      } catch (e) {
        spinner.fail('Port inspection failed');
        ctx.error(e instanceof Error ? e.message : String(e));
        ctx.exit(1);
      }
    });
}
