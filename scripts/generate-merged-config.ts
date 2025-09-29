import { ConfigManagerModule } from '../src/modules/config-manager/config-manager-module.js';

async function main() {
  const cfgPath = process.env.RCC4_CONFIG_PATH || './routecodex.json';
  const port = 5513;
  const mergedPath = `./config/merged-config.${port}.json`;

  const manager = new ConfigManagerModule();
  await manager.initialize({
    autoReload: false,
    configPath: cfgPath,
    mergedConfigPath: mergedPath,
    systemModulesPath: './config/modules.json'
  });

  console.log(`Merged configuration generated at ${mergedPath}`);
}

main().catch(err => {
  console.error('Failed to generate merged configuration:', err);
  process.exit(1);
});

