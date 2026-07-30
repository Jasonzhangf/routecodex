#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.env.ROUTECODEX_REPO_ROOT
  ? path.resolve(process.env.ROUTECODEX_REPO_ROOT)
  : process.cwd();
const localCrate = path.join(
  repoRoot,
  'v3/crates/routecodex-v3-route-classifier'
);
const requiredFiles = [
  'Cargo.toml',
  'src/lib.rs',
  'src/active_turn.rs',
  'src/route.rs',
  'src/shell.rs',
  'src/tools.rs',
  'src/tests.rs'
].map((relative) => path.join(localCrate, relative));
const v3DependencyFiles = [
  'v3/Cargo.toml',
  'v3/Cargo.lock',
  'v3/crates/routecodex-v3-runtime/Cargo.toml',
  'v3/crates/routecodex-v3-runtime/src/nodes.rs',
  'v3/crates/routecodex-v3-virtual-router/Cargo.toml',
  'v3/crates/routecodex-v3-virtual-router/src/lib.rs',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml'
].map((relative) => path.join(repoRoot, relative));
const v2CargoFiles = [
  'sharedmodule/llmswitch-core/rust-core/Cargo.toml',
  'sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core/Cargo.toml',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml'
].map((relative) => path.join(repoRoot, relative));

const errors = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    errors.push(`missing V3-local classifier file: ${path.relative(repoRoot, file)}`);
  }
}

const read = (file) => {
  if (!fs.existsSync(file)) {
    errors.push(`missing owner binding file: ${path.relative(repoRoot, file)}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
};

const localCargo = read(path.join(localCrate, 'Cargo.toml'));
if (!localCargo.includes('name = "routecodex-v3-route-classifier"')) {
  errors.push('V3-local classifier crate must be named routecodex-v3-route-classifier');
}

const workspaceCargo = read(path.join(repoRoot, 'v3/Cargo.toml'));
if (!workspaceCargo.includes('"crates/routecodex-v3-route-classifier"')) {
  errors.push('v3/Cargo.toml must register crates/routecodex-v3-route-classifier');
}

for (const file of v3DependencyFiles) {
  const source = read(file);
  if (
    source.includes('route-classifier-core') ||
    source.includes('route_classifier_core') ||
    source.includes('sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core')
  ) {
    errors.push(
      `V3 owner surface still references V2/shared classifier: ${path.relative(repoRoot, file)}`
    );
  }
}

for (const file of [
  'v3/crates/routecodex-v3-runtime/Cargo.toml',
  'v3/crates/routecodex-v3-virtual-router/Cargo.toml'
].map((relative) => path.join(repoRoot, relative))) {
  const source = read(file);
  if (
    !source.includes(
      'routecodex-v3-route-classifier = { path = "../routecodex-v3-route-classifier" }'
    )
  ) {
    errors.push(
      `V3 consumer must use the local classifier dependency: ${path.relative(repoRoot, file)}`
    );
  }
}

for (const file of v2CargoFiles) {
  const source = read(file);
  if (
    source.includes('routecodex-v3-route-classifier') ||
    source.includes('v3/crates/routecodex-v3-route-classifier')
  ) {
    errors.push(
      `V2/shared owner must not depend on the V3 classifier: ${path.relative(repoRoot, file)}`
    );
  }
}

if (errors.length > 0) {
  console.error('[verify:v3-route-classifier-local-owner] failed');
  for (const error of [...new Set(errors)]) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  '[verify:v3-route-classifier-local-owner] ok owner=v3/crates/routecodex-v3-route-classifier'
);
