import { Command } from 'commander';

import {
  applyUserConfigMigrationPlan,
  collectUserConfigMigrationPlan,
  type UserConfigMigrationPlan
} from '../config/user-config-migration.js';

export type UserConfigMigrateCommandContext = {
  log?: (line: string) => void;
  error?: (line: string) => void;
};

function printPlan(log: (line: string) => void, plan: UserConfigMigrationPlan): void {
  log(`Legacy root: ${plan.legacyRoot}`);
  log(`Target root: ${plan.targetRoot}`);
  log(
    `Summary: total=${plan.summary.total} copy=${plan.summary.copy} overwrite=${plan.summary.overwrite} unchanged=${plan.summary.unchanged} conflict=${plan.summary.conflict}`
  );
  if (plan.summary.missingRoots.length > 0) {
    log(`Missing legacy roots: ${plan.summary.missingRoots.join(', ')}`);
  }
  for (const item of plan.items) {
    log(`${item.action.toUpperCase()} ${item.relativePath} -> ${item.targetPath}`);
  }
}

export function createUserConfigMigrateCommand(ctx?: UserConfigMigrateCommandContext): Command {
  const log = ctx?.log ?? ((line: string) => console.log(line));
  const error = ctx?.error ?? ((line: string) => console.error(line));

  const command = new Command('migrate-user-config');
  command
    .description('Plan/apply migration of user-owned config artifacts from ~/.routecodex to ~/.rcc')
    .option('--apply', 'Apply the migration plan and copy files into ~/.rcc')
    .option('--overwrite', 'Overwrite conflicting destination files in ~/.rcc')
    .option('--json', 'Output machine-readable JSON')
    .option('--home <dir>', 'Override home directory (for testing/admin use)')
    .action(async (options: { apply?: boolean; overwrite?: boolean; json?: boolean; home?: string }) => {
      try {
        const plan = await collectUserConfigMigrationPlan({
          homeDir: options.home,
          overwrite: options.overwrite === true
        });

        if (options.json) {
          if (options.apply) {
            const result = await applyUserConfigMigrationPlan(plan);
            log(JSON.stringify({ plan, result }, null, 2));
            return;
          }
          log(JSON.stringify({ plan }, null, 2));
          return;
        }

        printPlan(log, plan);
        if (!options.apply) {
          log('Dry-run only. Re-run with --apply to copy config.json/config/provider into ~/.rcc.');
          return;
        }

        const result = await applyUserConfigMigrationPlan(plan);
        log(
          `Applied: copied=${result.copied} overwritten=${result.overwritten} skippedConflicts=${result.skippedConflicts}`
        );
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  return command;
}
