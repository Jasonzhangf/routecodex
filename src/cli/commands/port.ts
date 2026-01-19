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

export type PortCommandContext = {
  defaultPort: number;
  createSpinner: (text: string) => Promise<Spinner>;
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

export function createPortCommand(program: Command, ctx: PortCommandContext): void {
  program
    .command('port')
    .description('Port utilities (doctor)')
    .argument('<sub>', 'Subcommand: doctor')
    .argument('[port]', `Port number (e.g., ${ctx.defaultPort})`)
    .option('--kill', 'Kill all listeners on the port')
    .action(async (sub: string, portArg: string | undefined, opts: { kill?: boolean }) => {
      if ((sub || '').toLowerCase() !== 'doctor') {
        ctx.error(chalk.red('Unknown subcommand. Use: rcc port doctor [port] [--kill]'));
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
          spinner.fail('Missing port. Provide an explicit port or set it in ~/.routecodex/config.json');
          ctx.exit(1);
        }

        const pids = ctx.findListeningPids(port);
        spinner.stop();
        ctx.log(chalk.cyan(`Port ${port} listeners:`));

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

        if (opts.kill && pids.length) {
          const ksp = await ctx.createSpinner(`Killing ${pids.length} listener(s) on ${port}...`);
          for (const pid of pids) {
            try {
              ctx.killPidBestEffort(pid, { force: true });
            } catch (e) {
              ksp.warn(`Failed to kill ${pid}: ${(e as Error).message}`);
            }
          }
          await ctx.sleep(300);
          const remain = ctx.findListeningPids(port);
          if (remain.length) {
            ksp.fail(`Some listeners remain: ${remain.join(', ')}`);
            ctx.exit(1);
          }
          ksp.succeed(`Port ${port} is now free.`);
        }
      } catch (e) {
        spinner.fail('Port inspection failed');
        ctx.error(e instanceof Error ? e.message : String(e));
        ctx.exit(1);
      }
    });
}
