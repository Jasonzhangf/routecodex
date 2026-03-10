#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function importEngineLegacy() {
  const url = pathToFileURL(
    path.join(projectRoot, 'dist', 'router', 'virtual-router', 'engine-legacy.js')
  ).href;
  return import(`${url}?t=${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  delete process.env.LLMSWITCH_ALLOW_ENGINE_LEGACY_IMPORTS;
  delete process.env.ROUTECODEX_ALLOW_ENGINE_LEGACY_IMPORTS;

  let blocked = false;
  try {
    await importEngineLegacy();
  } catch (error) {
    blocked = String(error?.message || error).includes('fail-closed');
  }
  assert.equal(blocked, true, 'engine-legacy import should fail-closed by default');

  process.env.LLMSWITCH_ALLOW_ENGINE_LEGACY_IMPORTS = '1';
  const mod = await importEngineLegacy();
  assert.equal(typeof mod.VirtualRouterEngine, 'function');

  console.log('✅ engine-legacy import guard regression passed');
}

main().catch((error) => {
  console.error('❌ engine-legacy import guard regression failed:', error);
  process.exit(1);
});
