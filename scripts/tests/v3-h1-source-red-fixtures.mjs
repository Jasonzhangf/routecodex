#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-static-hook-registry.mjs');
const targetFile = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const fixtures = [
  ['dynamic hook', '\nfn dynamic_hook_discovery() {}\n', /dynamic hook/],
  ['missing-hook fallback', '\nfn default_hook_fallback() {}\n', /fallback/],
  ['Provider network', '\nfn provider_network_shortcut() { let _ = reqwest::Client::new(); }\n', /Provider network/],
  ['provider-specific branch', '\nfn provider_id_branch() {}\n', /provider-specific/],
  ['second response exit', '\nstruct V3ServerRespOutbound07AlternateResponse;\n', /second response exit/],
  ['non-adjacent builder', '\npub fn build_v3_hub_req_target_06_from_v3_hub_req_inbound_02() {}\n', /non-adjacent/],
];
const failures = [];
for (const [name, mutation, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-h1-source-'));
  try {
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), { recursive: true, filter: (path) => !path.includes('/target/') });
    const target = join(root, targetFile);
    const source = readFileSync(target, 'utf8');
    const testModule = source.indexOf('#[cfg(test)]');
    writeFileSync(target, source.slice(0, testModule) + mutation + source.slice(testModule));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: gate unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-h1-source-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-h1-source-red-fixtures] ok (${fixtures.length} forbidden H1 mutations rejected)`);
