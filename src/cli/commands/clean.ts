import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
};

export type CleanCommandContext = {
  logger: LoggerLike;
  getHomeDir?: () => string;
  getCwd?: () => string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'rmSync'>;
  joinPath?: (...parts: string[]) => string;
};

export function createCleanCommand(program: Command, ctx: CleanCommandContext): void {
  const getHomeDir = ctx.getHomeDir ?? (() => homedir());
  const getCwd = ctx.getCwd ?? (() => process.cwd());
  const fsImpl = ctx.fsImpl ?? fs;
  const joinPath = ctx.joinPath ?? path.join;

  program
    .command('clean')
    .description('Clean captured data and debug logs')
    .option('-y, --yes', 'Confirm deletion without prompt')
    .option('--what <targets>', 'Targets to clean: captures,logs,all', 'all')
    .action(async (options: { yes?: boolean; what?: string }) => {
      const confirm = Boolean(options.yes);
      const what = String(options.what || 'all');
      if (!confirm) {
        ctx.logger.warning('Add --yes to confirm deletion.');
        ctx.logger.info('Example: rcc clean --yes --what all');
        return;
      }

      const home = getHomeDir();
      const targets: Array<{ path: string; label: string }> = [];
      if (what === 'captures' || what === 'all') {
        targets.push({ path: joinPath(home, '.routecodex', 'codex-samples'), label: 'captures' });
      }
      if (what === 'logs' || what === 'all') {
        targets.push({ path: joinPath(getCwd(), 'debug-logs'), label: 'debug-logs' });
        targets.push({ path: joinPath(home, '.routecodex', 'logs'), label: 'user-logs' });
      }

      let removedAny = false;
      for (const t of targets) {
        try {
          if (fsImpl.existsSync(t.path)) {
            const entries = fsImpl.readdirSync(t.path);
            for (const name of entries) {
              const p = joinPath(t.path, name);
              try {
                fsImpl.rmSync(p, { recursive: true, force: true });
                removedAny = true;
              } catch (e) {
                ctx.logger.warning(`Failed to remove ${p}: ${(e as Error).message}`);
              }
            }
            ctx.logger.success(`Cleared ${t.label} at ${t.path}`);
          }
        } catch (e) {
          ctx.logger.warning(`Unable to access ${t.label} at ${t.path}: ${(e as Error).message}`);
        }
      }
      if (!removedAny) {
        ctx.logger.info('Nothing to clean.');
      }
    });
}

