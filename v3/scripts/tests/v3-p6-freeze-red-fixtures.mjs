#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-p6-freeze.mjs');
const fixtures = [
  ['Chat Process expansion', 'v3/crates/routecodex-v3-runtime/src/kernel.rs', '\nfn p6_chat_process_expansion() {}\n', /Chat Process expansion/],
  ['Relay expansion', 'v3/crates/routecodex-v3-runtime/src/hooks.rs', '\nfn p6_relay_hook() {}\n', /Relay expansion/],
  ['other protocol expansion', 'v3/crates/routecodex-v3-runtime/src/nodes.rs', '\nstruct P6AnthropicRequest;\n', /other entry protocol expansion/],
  ['provider special case', 'v3/crates/routecodex-v3-runtime/src/hooks.rs', '\nfn p6_provider_case(provider_id: &str) -> bool { provider_id == "special" }\n', /provider identity\/family/],
  ['second lifecycle', 'v3/crates/routecodex-v3-runtime/src/kernel.rs', '\npub async fn execute_v3_secondary_responses_direct_runtime() {}\n', /second lifecycle executor/],
  ['second response exit', 'v3/crates/routecodex-v3-server/src/lib.rs', '\nfn secondary_response_exit() {}\n', /second response exit/],
  ['dynamic hook', 'v3/crates/routecodex-v3-runtime/src/hooks.rs', '\nfn dynamic_hook_discovery() {}\n', /dynamic hook behavior/],
];

const failures = [];
for (const [name, file, mutation, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-p6-freeze-'));
  try {
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), { recursive: true, filter: (path) => !path.includes('/target/') });
    const target = join(root, file);
    const source = readFileSync(target, 'utf8');
    const testModule = source.indexOf('#[cfg(test)]');
    writeFileSync(target, testModule === -1 ? source + mutation : source.slice(0, testModule) + mutation + source.slice(testModule));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: gate unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-p6-freeze-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-p6-freeze-red-fixtures] ok (${fixtures.length} forbidden P6 expansions rejected)`);
