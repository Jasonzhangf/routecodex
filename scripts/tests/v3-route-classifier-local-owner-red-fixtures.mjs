#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const gate = path.join(
  repoRoot,
  'scripts/architecture/verify-v3-route-classifier-local-owner.mjs'
);

function write(root, relative, source) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-route-classifier-owner-'));
  const files = {
    'v3/Cargo.toml': '[workspace]\nmembers=["crates/routecodex-v3-route-classifier"]\n',
    'v3/Cargo.lock': 'name = "routecodex-v3-route-classifier"\n',
    'v3/crates/routecodex-v3-route-classifier/Cargo.toml':
      '[package]\nname = "routecodex-v3-route-classifier"\n',
    'v3/crates/routecodex-v3-route-classifier/src/lib.rs': 'mod active_turn;\n',
    'v3/crates/routecodex-v3-route-classifier/src/active_turn.rs': '',
    'v3/crates/routecodex-v3-route-classifier/src/route.rs': '',
    'v3/crates/routecodex-v3-route-classifier/src/shell.rs': '',
    'v3/crates/routecodex-v3-route-classifier/src/tools.rs': '',
    'v3/crates/routecodex-v3-route-classifier/src/tests.rs': '',
    'v3/crates/routecodex-v3-runtime/Cargo.toml':
      'routecodex-v3-route-classifier = { path = "../routecodex-v3-route-classifier" }\n',
    'v3/crates/routecodex-v3-runtime/src/nodes.rs':
      'use routecodex_v3_route_classifier::classify_route;\n',
    'v3/crates/routecodex-v3-virtual-router/Cargo.toml':
      'routecodex-v3-route-classifier = { path = "../routecodex-v3-route-classifier" }\n',
    'v3/crates/routecodex-v3-virtual-router/src/lib.rs':
      'use routecodex_v3_route_classifier::RouteClassification;\n',
    'docs/architecture/v3-function-map.yml':
      'owner: v3/crates/routecodex-v3-route-classifier\n',
    'docs/architecture/v3-mainline-call-map.yml':
      'callee_file: v3/crates/routecodex-v3-route-classifier/src/route.rs\n',
    'docs/architecture/v3-verification-map.yml':
      'owner: routecodex-v3-route-classifier\n',
    'sharedmodule/llmswitch-core/rust-core/Cargo.toml':
      'members=["crates/route-classifier-core"]\n',
    'sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core/Cargo.toml':
      'name = "route-classifier-core"\n',
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml':
      'route-classifier-core = { path = "../route-classifier-core" }\n',
    ...overrides
  };
  for (const [relative, source] of Object.entries(files)) {
    write(root, relative, source);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [gate], {
    cwd: repoRoot,
    env: { ...process.env, ROUTECODEX_REPO_ROOT: root },
    encoding: 'utf8'
  });
}

const positive = run(fixture());
assert.equal(positive.status, 0, positive.stderr || positive.stdout);

const sharedDependency = run(
  fixture({
    'v3/crates/routecodex-v3-runtime/Cargo.toml':
      'route-classifier-core = { path = "../../../sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core" }\n'
  })
);
assert.notEqual(sharedDependency.status, 0);
assert.match(sharedDependency.stderr, /still references V2\/shared classifier/);

const staleMap = run(
  fixture({
    'docs/architecture/v3-mainline-call-map.yml':
      'callee_file: sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core/src/route.rs\n'
  })
);
assert.notEqual(staleMap.status, 0);
assert.match(staleMap.stderr, /still references V2\/shared classifier/);

const reverseDependency = run(
  fixture({
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml':
      'routecodex-v3-route-classifier = { path = "../../../../v3/crates/routecodex-v3-route-classifier" }\n'
  })
);
assert.notEqual(reverseDependency.status, 0);
assert.match(reverseDependency.stderr, /V2\/shared owner must not depend/);

console.log('[test:v3-route-classifier-local-owner-red-fixtures] ok');
