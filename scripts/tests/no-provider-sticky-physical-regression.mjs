#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const roots = [
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_provider_key.rs',
  'sharedmodule/llmswitch-core/src/router/virtual-router',
  'sharedmodule/llmswitch-core/src/servertool/backend-route-flow-policy.ts',
  'sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts',
  'sharedmodule/llmswitch-core/src/servertool/skeleton-config.ts',
  'sharedmodule/llmswitch-core/docs',
  'sharedmodule/llmswitch-core/scripts/tests',
  'sharedmodule/llmswitch-core/tests',
  'sharedmodule/llmswitch-core/config',
  'tests/servertool',
  'docs'
];
const banned = [
  'stickyTarget',
  'sticky_target',
  'stickyProvider',
  'sticky-queue',
  'sticky_queue',
  'stickyqueue',
  'disableStickyRoutes',
  'native-virtual-router-sticky-semantics'
];
function* filesUnder(target) {
  const full = path.join(repo, target);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(full)) {
    const rel = path.join(target, entry);
    const st = fs.statSync(path.join(repo, rel));
    if (st.isDirectory()) yield* filesUnder(rel);
    else yield rel;
  }
}

const hits = [];
for (const root of roots) {
  for (const rel of filesUnder(root)) {
    if (rel === 'scripts/tests/no-provider-sticky-physical-regression.mjs') continue;
    if (!/\.(rs|ts|tsx|mjs|md|json)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(repo, rel), 'utf8');
    for (const term of banned) {
      if (text.includes(term)) hits.push({ file: rel, term });
    }
  }
}
assert.deepEqual(hits, [], `provider sticky semantics must be physically absent: ${JSON.stringify(hits, null, 2)}`);
console.log(JSON.stringify({ ok: true, checkedRoots: roots.length, bannedTerms: banned.length }, null, 2));
