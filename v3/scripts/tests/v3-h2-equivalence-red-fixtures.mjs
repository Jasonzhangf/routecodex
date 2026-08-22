#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-h2-equivalence-harness.mjs');
const fixtures = [
  {
    name: 'CLI entry replaced by library server',
    file: 'v3/crates/routecodex-v3-cli/tests/h2_p6_controlled_replay.rs',
    from: 'env!("CARGO_BIN_EXE_rccv3")',
    to: 'spawn_v3_server_aggregate',
    diagnostic: /forbidden internal runtime\/server entry|missing env!\("CARGO_BIN_EXE_rccv3"\)/,
  },
  {
    name: 'default pool exhaustion coverage removed',
    file: 'v3/crates/routecodex-v3-cli/tests/h2_p6_controlled_replay.rs',
    from: 'default_pool_exhaustion',
    to: 'default_pool_removed',
    diagnostic: /missing scenario marker default_pool_exhaustion/,
  },
  {
    name: 'dry run no-network assertion removed',
    file: 'v3/crates/routecodex-v3-cli/tests/h2_p6_controlled_replay.rs',
    from: 'provider_network_send',
    to: 'provider_send_unchecked',
    diagnostic: /missing provider_network_send/,
  },
  {
    name: 'H2 baseline doc scenario removed',
    file: 'docs/goals/v3-hub-h2-p6-responses-direct-characterization.md',
    from: 'target_local_reselection',
    to: 'target_local_removed',
    diagnostic: /missing scenario row target_local_reselection/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-h2-red-'));
  try {
    for (const dir of ['scripts', 'v3', 'docs']) {
      cpSync(resolve(repoRoot, dir), join(root, dir), {
        recursive: true,
        filter: (source) => !source.includes('/target/'),
      });
    }
    cpSync(resolve(repoRoot, 'package.json'), join(root, 'package.json'));
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(fixture.from)) throw new Error('fixture source missing: ' + fixture.from);
    writeFileSync(target, source.split(fixture.from).join(fixture.to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    if (result.status === 0) failures.push(fixture.name + ': gate unexpectedly passed');
    else if (!fixture.diagnostic.test(output)) failures.push(fixture.name + ': wrong diagnostic: ' + output.slice(-800));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-h2-equivalence-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[test:v3-h2-equivalence-red-fixtures] ok (' + fixtures.length + ' forbidden mutations rejected)');
