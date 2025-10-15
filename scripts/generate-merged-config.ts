// Use built JS from dist to avoid ts-node/tsx dependency
import { ConfigManagerModule } from '../dist/modules/config-manager/config-manager-module.js';

function resolveConfigPathFromArgs(): string {
  const argv = process.argv.slice(2);
  const idx = argv.findIndex(a => a === '--config' || a === '-c');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  if (process.env.ROUTECODEX_CONFIG && process.env.ROUTECODEX_CONFIG.trim()) return process.env.ROUTECODEX_CONFIG.trim();
  const home = process.env.HOME || '';
  return `${home}/.routecodex/config.json`;
}

async function main() {
  const cfgPath = resolveConfigPathFromArgs();
  const outPath = './config/merged-config.generated.json';

  const manager = new ConfigManagerModule();
  await manager.initialize({
    autoReload: false,
    configPath: cfgPath,
    mergedConfigPath: outPath,
    systemModulesPath: './config/modules.json'
  });

  console.log(`Merged configuration generated at ${outPath}`);
  // Force process exit to avoid lingering handles in dependent modules
  process.exit(0);
}

main().catch(err => {
  console.error('Failed to generate merged configuration:', err);
  process.exit(1);
});
