#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function main() {
  process.env.LLMSWITCH_WARN_LEGACY_SURFACES = '1';
  process.env.LLMSWITCH_ALLOW_ENGINE_LEGACY_IMPORTS = '1';

  const { VirtualRouterEngine } = await import(
    path.join(projectRoot, 'dist', 'router', 'virtual-router', 'engine-legacy.js')
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    const engine = new VirtualRouterEngine();
    engine.routeWeight('default');
    engine.resolveSessionScope({
      requestId: 'req_legacy_warn',
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request'
    });
  } finally {
    console.warn = originalWarn;
    delete process.env.LLMSWITCH_WARN_LEGACY_SURFACES;
    delete process.env.LLMSWITCH_ALLOW_ENGINE_LEGACY_IMPORTS;
  }

  assert.equal(
    warnings.some((line) => line.includes('[engine-legacy] compatibility surface invoked: routeWeight')),
    true
  );
  assert.equal(
    warnings.some((line) => line.includes('[engine-legacy] compatibility surface invoked: resolveSessionScope')),
    true
  );

  console.log('✅ engine-legacy compatibility warning regression passed');
}

main().catch((error) => {
  console.error('❌ engine-legacy compatibility warning regression failed:', error);
  process.exit(1);
});
