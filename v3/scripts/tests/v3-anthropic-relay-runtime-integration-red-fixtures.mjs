#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const manifest = 'docs/architecture/manifests/v3.anthropic_relay.controlled_runtime.mainline.yml';
const callMap = 'docs/architecture/v3-mainline-call-map.yml';
const repo = [process.cwd(), resolve(process.cwd(), '..')]
  .find((candidate) => existsSync(resolve(candidate, manifest)));
if (!repo) throw new Error('RouteCodex repository root not found');
const verifier = resolve(repo, 'v3/scripts/architecture/verify-v3-anthropic-relay-runtime-integration.mjs');
const cases = [
  ['manifest adjacent edge drift', manifest, 'step_id: v3-anthropic-relay-06', 'step_id: v3-anthropic-relay-06x', /edge v3-anthropic-relay-06 mismatch/],
  [
    'SSE compat call-map drift',
    callMap,
    'step_id: v3-anthropic-relay-12\n    from_node: V3ProviderRespInbound01Raw\n    to_node: ProviderRespCompat02ProviderCompat\n    caller_symbol: execute_v3_anthropic_relay_runtime\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs\n    callee_symbol: build_provider_resp_compat_02_from_v3_provider_resp_inbound_01',
    'step_id: v3-anthropic-relay-12\n    from_node: V3ProviderRespInbound01Raw\n    to_node: ProviderRespCompat02ProviderCompat\n    caller_symbol: execute_v3_anthropic_relay_runtime\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs\n    callee_symbol: build_provider_resp_compat_02_from_v3_provider_resp_inbound_01_sse_removed',
    /v3-anthropic-relay-12 must call/,
  ],
  [
    'Resp05 payload call-map drift',
    callMap,
    'step_id: v3-anthropic-relay-15\n    from_node: V3HubRespChatProcess03Governed\n    to_node: V3HubRespOutbound05ClientSemantic\n    caller_symbol: execute_v3_anthropic_relay_runtime\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs\n    callee_symbol: build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03',
    'step_id: v3-anthropic-relay-15\n    from_node: V3HubRespChatProcess03Governed\n    to_node: V3HubRespOutbound05ClientSemantic\n    caller_symbol: execute_v3_anthropic_relay_runtime\n    caller_file: v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs\n    callee_symbol: build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_removed',
    /v3-anthropic-relay-15 must call/,
  ],
];

const baseline = spawnSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8' });
if (baseline.status !== 0) {
  throw new Error(`manifest baseline failed: ${baseline.stdout ?? ''}\n${baseline.stderr ?? ''}`);
}
const failures = [];
for (const [name, relative, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-anthropic-relay-runtime-red-'));
  try {
    for (const path of [manifest, callMap]) cpSync(resolve(repo, path), resolve(root, path));
    const target = resolve(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-anthropic-relay-runtime-integration-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-anthropic-relay-runtime-integration-red-fixtures] GREEN baseline + ${cases.length} manifest/call-map mutations rejected`);
