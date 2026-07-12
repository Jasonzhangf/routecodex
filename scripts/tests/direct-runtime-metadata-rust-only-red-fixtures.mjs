import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-direct-runtime-metadata-'));

function seed() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  for (const relPath of [
    'src/server/runtime/http-server/direct-runtime-metadata.ts',
    'src/modules/llmswitch/bridge/direct-runtime-metadata-host.ts',
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/direct_runtime_metadata_projection.rs',
  ]) {
    fs.mkdirSync(path.dirname(path.join(fixtureRoot, relPath)), { recursive: true });
    fs.copyFileSync(path.join(root, relPath), path.join(fixtureRoot, relPath));
  }
}

function expectFailure(name, mutate, expected) {
  seed();
  mutate();
  const result = spawnSync(process.execPath, ['scripts/architecture/verify-direct-runtime-metadata-rust-only.mjs'], {
    cwd: root,
    env: { ...process.env, ROUTECODEX_DIRECT_RUNTIME_METADATA_SCAN_ROOT: fixtureRoot },
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes(expected)) {
    throw new Error(`${name}: expected failure containing ${JSON.stringify(expected)}\n${output}`);
  }
}

expectFailure('ts-key-array-revival', () => {
  fs.appendFileSync(path.join(fixtureRoot, 'src/server/runtime/http-server/direct-runtime-metadata.ts'), '\nconst DIRECT_PROVIDER_RUNTIME_METADATA_KEYS = ["clientRequestId"];\n');
}, 'TS semantic projection residue');

expectFailure('ts-control-projection-revival', () => {
  fs.appendFileSync(path.join(fixtureRoot, 'src/server/runtime/http-server/direct-runtime-metadata.ts'), '\nfunction projectRouteMetadataCenterSnapshot() { return {}; }\n');
}, 'TS semantic projection residue');

expectFailure('host-semantic-revival', () => {
  fs.appendFileSync(path.join(fixtureRoot, 'src/modules/llmswitch/bridge/direct-runtime-metadata-host.ts'), '\nconst CONTROL_KEYS = ["retryProviderKey"];\n');
}, 'leaked into TS host');

console.log('[test:direct-runtime-metadata-rust-only-red-fixtures] ok');
