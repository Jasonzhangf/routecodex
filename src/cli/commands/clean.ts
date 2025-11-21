import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../logger.js';

export function registerCleanCommand(program: Command) {
  program
    .command('clean')
    .description('Clean captured data and debug logs')
    .option('-y, --yes', 'Confirm deletion without prompt')
    .option('--what <targets>', 'Targets to clean: captures,logs,all', 'all')
    .action(async (options) => {
      const confirm = Boolean(options.yes);
      const what = String(options.what || 'all');
      if (!confirm) {
        logger.warning('Add --yes to confirm deletion.');
        logger.info('Example: rcc clean --yes --what all');
        return;
      }
      const home = homedir();
      const targets: Array<{ path: string; label: string }> = [];
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
              try { fs.rmSync(p, { recursive: true, force: true }); removedAny = true; }
              catch (e) { logger.warning(`Failed to remove ${p}: ${(e as Error).message}`); }
            }
            logger.success(`Cleared ${t.label} at ${t.path}`);
          }
        } catch (e) {
          logger.warning(`Unable to access ${t.label} at ${t.path}: ${(e as Error).message}`);
        }
      }
      if (!removedAny) logger.info('Nothing to clean.');
    });
}

