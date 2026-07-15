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
const cases = [
  ['missing Req06 edge', runtime, '    trace.push("V3HubReqTarget06Resolved");', '', /V3HubReqTarget06Resolved/],
  ['fabricated static trace', runtime, '    let mut trace = Vec::with_capacity(15);', '    const SUCCESS_TRACE: [&str; 0] = [];\n    let mut trace = Vec::with_capacity(15);', /SUCCESS_TRACE/],
  ['transport skipped', runtime, 'transport.send(transport_request).await', 'Ok::<_, V3ProviderError>(unreachable!())', /transport\.send/],
  ['dynamic hooks', runtime, 'compile_v3_hub_v1_static_registry()', 'std::fs::read_dir(".").unwrap(); compile_v3_hub_v1_static_registry()', /dynamic|read_dir/],
  ['fallback added', runtime, 'let mut trace = Vec::with_capacity(15);', 'let fallback = true; let mut trace = Vec::with_capacity(15);', /fallback/],
  ['P6 extension', runtime, 'let mut trace = Vec::with_capacity(15);', 'let _ = "ResponsesDirect11Policy"; let mut trace = Vec::with_capacity(15);', /ResponsesDirect/],
  ['driver bypasses Server', driver, 'use routecodex_v3_server::execute_v3_anthropic_messages_request;', 'use routecodex_v3_runtime::execute_v3_anthropic_relay_runtime_with_default_transport;', /routecodex_v3_server/],
  ['handler SSE business allowlist', server, 'fn anthropic_relay_output_response(', 'const RESPONSE_EVENT: &str = "response.output_item.added";\nfn anthropic_relay_output_response(', /response.*output_item/],
];

const failures = [];
for (const [name, relative, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-anthropic-relay-runtime-red-'));
  try {
    for (const path of [runtime, 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs', 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs', server, driver, 'v3/crates/routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs', 'docs/goals/v3-anthropic-relay-runtime-integration-test-design.md']) {
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
