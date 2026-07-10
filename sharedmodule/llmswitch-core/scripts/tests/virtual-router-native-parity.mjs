#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const { loadNativeRouterHotpathBinding } = await import(
    path.join(repoRoot, 'scripts', 'helpers', 'native-router-hotpath-loader.mjs')
  );
  const binding = loadNativeRouterHotpathBinding();
  const required = [
    'analyzePendingToolSyncJson',
    'analyzeContinueExecutionInjectionJson',
    'analyzeChatProcessMediaJson',
    'analyzeChatWebSearchIntentJson',
    'parseVirtualRouterHitProviderKeyJson'
  ];
  const missing = required.filter((name) => typeof binding?.[name] !== 'function');
  if (missing.length) {
    throw new Error(`missing native exports: ${missing.join(', ')}`);
  }
  console.log('[virtual-router-native-parity] ok native exports available');
}

main().catch((error) => {
  console.error('[virtual-router-native-parity] failed', error);
  process.exit(1);
});
