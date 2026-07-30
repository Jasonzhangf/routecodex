#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-anthropic-relay-runtime-integration.mjs');
const runtime = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs';
const server = 'v3/crates/routecodex-v3-server/src/lib.rs';
const driver = 'v3/crates/routecodex-v3-server/src/bin/v3-anthropic-relay-driver.rs';
const manifest = 'docs/architecture/manifests/v3.anthropic_relay.controlled_runtime.mainline.yml';
const callMap = 'docs/architecture/v3-mainline-call-map.yml';
const packagePath = 'package.json';
const cases = [
  ['missing Req06 edge', runtime, '    trace.push("V3HubReqTarget06Resolved");', '', /V3HubReqTarget06Resolved/],
  ['fabricated static trace', runtime, '    let mut trace = Vec::with_capacity(17);', '    const SUCCESS_TRACE: [&str; 0] = [];\n    let mut trace = Vec::with_capacity(17);', /SUCCESS_TRACE/],
  ['transport skipped', runtime, 'transport.send(transport_request).await', 'Ok::<_, V3ProviderError>(unreachable!())', /transport\.send/],
  ['dynamic hooks', runtime, 'compile_v3_hub_v1_static_registry()', 'std::fs::read_dir(".").unwrap(); compile_v3_hub_v1_static_registry()', /dynamic|read_dir/],
  ['fallback added', runtime, 'let mut trace = Vec::with_capacity(17);', 'let fallback = true; let mut trace = Vec::with_capacity(17);', /fallback/],
  ['P6 extension', runtime, 'let mut trace = Vec::with_capacity(17);', 'let _ = "ResponsesDirect11Policy"; let mut trace = Vec::with_capacity(17);', /ResponsesDirect/],
  ['driver bypasses Server', driver, 'use routecodex_v3_server::execute_v3_anthropic_messages_request;', 'use routecodex_v3_runtime::execute_v3_anthropic_relay_runtime_with_default_transport;', /routecodex_v3_server/],
  ['handler SSE business allowlist', server, 'fn anthropic_relay_output_response(', 'const RESPONSE_EVENT: &str = "response.output_item.added";\nfn anthropic_relay_output_response(', /response.*output_item/],
  ['pre-Resp04 SSE projector revived', 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs', 'pub fn project_v3_responses_json_as_anthropic_events(', 'pub fn project_v3_responses_sse_as_anthropic_events() {}\npub fn project_v3_responses_json_as_anthropic_events(', /project_v3_responses_sse_as_anthropic_events/],
  ['manifest adjacent edge drift', manifest, 'step_id: v3-anthropic-relay-06', 'step_id: v3-anthropic-relay-06x', /edge v3-anthropic-relay-06 mismatch/],
  [
    'SSE compat call-map drift',
    callMap,
    'callee_symbol: build_provider_resp_compat_02_from_v3_provider_resp_inbound_01_sse',
    'callee_symbol: build_provider_resp_compat_02_from_v3_provider_resp_inbound_01',
    /v3-anthropic-relay-12 must call/,
  ],
  [
    'Resp05 payload call-map drift',
    callMap,
    'callee_symbol: build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload',
    'callee_symbol: build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
    /v3-anthropic-relay-16 must call/,
  ],
  [
    'CI wiring removed',
    packagePath,
    'npm run verify:build-script-tiering && npm run test:v3-anthropic-relay-runtime-integration && npm run verify:v3-anthropic-relay-runtime-integration',
    'npm run verify:build-script-tiering && npm run verify:v3-anthropic-relay-runtime-integration',
    /verify:architecture-ci-longtail missing npm run test:v3-anthropic-relay-runtime-integration/,
  ],
];

const failures = [];
for (const [name, relative, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-anthropic-relay-runtime-red-'));
  try {
    for (const path of [runtime, 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs', server, driver, 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs', 'docs/goals/v3-anthropic-relay-runtime-integration-test-design.md', manifest, callMap, packagePath]) {
      cpSync(resolve(repo, path), resolve(root, path), { recursive: true });
    }
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
console.log(`[test:v3-anthropic-relay-runtime-integration-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
