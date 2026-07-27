#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-legacy-harvest-orphan-gate-'));
const gateSource = path.join(root, 'scripts/architecture/verify-legacy-text-tool-harvest-napi-orphans.mjs');
const gateTarget = path.join(fixtureRoot, 'scripts/architecture/verify-legacy-text-tool-harvest-napi-orphans.mjs');
const bindingGateSource = path.join(root, 'scripts/architecture/verify-legacy-text-tool-harvest-napi-binding.mjs');
const bindingGateTarget = path.join(fixtureRoot, 'scripts/architecture/verify-legacy-text-tool-harvest-napi-binding.mjs');
const crateSource = path.join(
  fixtureRoot,
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
);
const helperSource = path.join(fixtureRoot, 'tests/sharedmodule/helpers');

fs.mkdirSync(path.dirname(gateTarget), { recursive: true });
fs.mkdirSync(crateSource, { recursive: true });
fs.mkdirSync(helperSource, { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'sharedmodule/llmswitch-core'), { recursive: true });
fs.copyFileSync(gateSource, gateTarget);
fs.copyFileSync(bindingGateSource, bindingGateTarget);
fs.writeFileSync(path.join(crateSource, 'lib.rs'), 'pub fn live_owner() {}\n');
fs.writeFileSync(
  path.join(fixtureRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json'),
  '[]\n',
);
fs.writeFileSync(
  path.join(fixtureRoot, 'package.json'),
  `${JSON.stringify({
    scripts: {
      'verify:architecture-ci': 'npm run verify:architecture-ci-longtail',
      'verify:architecture-ci-longtail':
        'npm run test:legacy-text-tool-harvest-napi-orphans-red-fixtures && npm run verify:legacy-text-tool-harvest-napi-orphans',
      'build:native-hotpath':
        'node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs && npm run verify:legacy-text-tool-harvest-napi-binding',
    },
  }, null, 2)}\n`,
);

function runGate() {
  return spawnSync(process.execPath, [gateTarget], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
}

const baseline = runGate();
assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);

fs.writeFileSync(
  path.join(crateSource, 'lib.rs'),
  '#[napi(js_name = "harvestToolCallsFromTextJson")]\npub fn revived_alias() {}\n',
);
const revivedRustAlias = runGate();
assert.notEqual(revivedRustAlias.status, 0, 'revived aliased Rust export must fail the orphan gate');
assert.match(revivedRustAlias.stderr, /harvestToolCallsFromTextJson/);

fs.writeFileSync(
  path.join(crateSource, 'lib.rs'),
  '#[napi]\npub fn harvest_tool_calls_from_text_json() {}\n',
);
const revivedDefaultRustExport = runGate();
assert.notEqual(revivedDefaultRustExport.status, 0, 'revived default napi-rs export must fail the orphan gate');
assert.match(revivedDefaultRustExport.stderr, /harvest_tool_calls_from_text_json/);

fs.writeFileSync(path.join(crateSource, 'lib.rs'), 'pub fn live_owner() {}\n');
fs.writeFileSync(
  path.join(helperSource, 'revived-wrapper.ts'),
  'export function harvestToolsWithNative() { return {}; }\n',
);
const revivedWrapper = runGate();
assert.notEqual(revivedWrapper.status, 0, 'revived TS wrapper must fail the orphan gate');
assert.match(revivedWrapper.stderr, /harvestToolsWithNative/);

const cleanBinding = path.join(fixtureRoot, 'clean-binding.cjs');
fs.writeFileSync(cleanBinding, 'module.exports = {};\n');
const cleanBindingCheck = spawnSync(process.execPath, [bindingGateTarget, cleanBinding], {
  cwd: fixtureRoot,
  encoding: 'utf8',
});
assert.equal(cleanBindingCheck.status, 0, cleanBindingCheck.stderr || cleanBindingCheck.stdout);

const revivedBinding = path.join(fixtureRoot, 'revived-binding.cjs');
fs.writeFileSync(
  revivedBinding,
  'module.exports = { harvestToolCallsFromTextJson() {} };\n',
);
const revivedBindingCheck = spawnSync(process.execPath, [bindingGateTarget, revivedBinding], {
  cwd: fixtureRoot,
  encoding: 'utf8',
});
assert.notEqual(revivedBindingCheck.status, 0, 'compiled binding with retired export must fail');
assert.match(revivedBindingCheck.stderr, /harvestToolCallsFromTextJson/);

console.log('[test:legacy-text-tool-harvest-napi-orphans-red-fixtures] ok');
