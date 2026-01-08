import { Command } from 'commander';
import chalk from 'chalk';
import { TokenDaemon } from '../token-daemon/index.js';
import {
  ensureCamoufoxProfileDir,
  ensureCamoufoxFingerprintForToken
} from '../providers/core/config/camoufox-launcher.js';

export function createCamoufoxBackfillCommand(): Command {
  const cmd = new Command('camoufox-backfill');

  cmd
    .description('Backfill Camoufox fingerprints for all discovered OAuth tokens')
    .action(async () => {
      const snapshot = await TokenDaemon.getSnapshot();
      let total = 0;
      let updated = 0;

      for (const providerSnapshot of snapshot.providers) {
        for (const token of providerSnapshot.tokens) {
          if (!token.provider || !token.alias) {
            continue;
          }
          total += 1;
          try {
            ensureCamoufoxProfileDir(token.provider, token.alias);
            ensureCamoufoxFingerprintForToken(token.provider, token.alias);
            updated += 1;
          } catch {
            // best-effort: failures for individual tokens are logged as a summary only
          }
        }
      }

      console.log(
        chalk.green('✓'),
        `Camoufox fingerprint backfill completed for ${updated}/${total} tokens`
      );
    });

  return cmd;
}

