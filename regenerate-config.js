#!/usr/bin/env node

import { ConfigManagerModule } from './dist/modules/config-manager/config-manager-module.js';

const configManager = new ConfigManagerModule('~/.routecodex/config/modelscope.json');

try {
  await configManager.initialize({
    autoReload: false,
    configPath: '~/.routecodex/config/modelscope.json',
    mergedConfigPath: './config/merged-config.json',
    systemModulesPath: './config/modules.json'
  });

  console.log('Configuration regenerated successfully');
  process.exit(0);
} catch (error) {
  console.error('Failed to regenerate configuration:', error);
  process.exit(1);
}