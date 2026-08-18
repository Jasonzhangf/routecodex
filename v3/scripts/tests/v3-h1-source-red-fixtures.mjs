#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-static-hook-registry.mjs');
const targetFile = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const hookFile = 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs';
const fixtures = [
  ['dynamic hook', '\nfn dynamic_hook_discovery() {}\n', /dynamic hook/],
  ['missing-hook fallback', '\nfn default_hook_fallback() {}\n', /fallback/],
  ['Provider network', '\nfn provider_network_shortcut() { let _ = reqwest::Client::new(); }\n', /Provider network/],
  ['provider-specific branch', '\nfn provider_family_branch() {}\n', /provider-specific/],
  ['second response exit', '\nstruct V3ServerRespOutbound07AlternateResponse;\n', /second response exit/],
  ['non-adjacent builder', '\npub fn build_v3_hub_req_target_06_from_v3_hub_req_inbound_02() {}\n', /non-adjacent/],
  ['missing entry hook', '', /missing static entry hook for V3HubReqInbound01ClientRaw/, hookFile, (source) => source.replace(/    static_hook\(\s*V3HubFixedNode::V3HubReqInbound01ClientRaw,\s*V3HubHookPhase::Entry,?\s*\),\n/, '')],
  ['runtime config read', '\nfn read_config_file() { let _ = std::fs::read_to_string("config.v3.toml"); }\n', /must not read config files/, hookFile],
  ['json round-trip clone', '\nfn clone_payload(value: &serde_json::Value) { let _ = serde_json::to_string(value); }\n', /forbidden JSON round-trip/, hookFile],
];
const failures = [];
for (const fixture of fixtures) {
  const [name, mutation, diagnostic] = fixture;
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-h1-source-'));
  try {
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), { recursive: true, filter: (path) => !path.includes('/target/') });
    const target = join(root, fixture[3] ?? targetFile);
    const source = readFileSync(target, 'utf8');
    const mutate = fixture[4];
    if (mutate) writeFileSync(target, mutate(source));
    else {
      const testModule = source.indexOf('#[cfg(test)]');
      const insertion = testModule < 0 ? source.length : testModule;
      writeFileSync(target, source.slice(0, insertion) + mutation + source.slice(insertion));
    }
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
