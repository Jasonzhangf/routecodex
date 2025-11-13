import { Command } from 'commander';
import path from 'path';
import { updateProviderModels } from '../tools/provider-update/index.js';

export function createProviderUpdateCommand(): Command {
  const cmd = new Command('provider');
  const update = new Command('update')
    .description('Update a provider\'s model list and generate a minimal single-provider config')
    .requiredOption('-c, --config <file>', 'Provider input config JSON (contains providerId/type/baseUrl/auth)')
    .option('-p, --provider <id>', 'Override providerId (else read from --config)')
    .option('--write', 'Write files instead of dry-run', false)
    .option('--output-dir <dir>', 'Output directory for provider config and lists (default: ~/.routecodex/provider/<id>)')
    .option('--blacklist-add <items>', 'Add comma-separated model ids to blacklist')
    .option('--blacklist-remove <items>', 'Remove comma-separated model ids from blacklist')
    .option('--blacklist-file <file>', 'Explicit blacklist.json path (overrides output-dir default)')
    .option('--list-only', 'Only list upstream models and exit', false)
    .option('--use-cache', 'Use cached models list on upstream failure', false)
    .option('--probe-keys', 'Probe apiKey list and set auth.apiKey to first working key', false)
    .option('--verbose', 'Verbose logs', false)
    .action(async (opts) => {
      const splitCsv = (s?: string): string[] => (typeof s === 'string' && s.trim()) ? s.split(',').map((x)=>x.trim()).filter(Boolean) : [];
      const args = {
        providerId: opts.provider as string | undefined,
        configPath: path.resolve(opts.config as string),
        write: !!opts.write,
        outputDir: opts.outputDir as string | undefined,
        blacklistAdd: splitCsv(opts.blacklistAdd as string | undefined),
        blacklistRemove: splitCsv(opts.blacklistRemove as string | undefined),
        blacklistFile: opts.blacklistFile as string | undefined,
        listOnly: !!opts.listOnly,
        useCache: !!opts.useCache,
        probeKeys: !!opts.probeKeys,
        verbose: !!opts.verbose
      };
      try {
        const result = await updateProviderModels(args);
        if (!args.listOnly) {
          console.log('Provider update summary:');
          console.log(`  provider: ${result.providerId}`);
          console.log(`  total upstream: ${result.totalRemote}`);
          console.log(`  filtered (after blacklist): ${result.filtered}`);
          console.log(`  output: ${result.outputPath}`);
          console.log(`  blacklist: ${result.blacklistPath}`);
        }
      } catch (e: any) {
        console.error('provider update failed:', e?.message || String(e));
        process.exit(1);
      }
    });
  cmd.addCommand(update);
  return cmd;
}
