#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-relay-request-semantics.mjs');
const fixtures = [
  {
    name: 'Req03 restore residue',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    from: 'return Ok(V3HubContinuationOwnership::RouteCodexLocalOwned);',
    to: 'let _restore = Arc::clone(&local.canonical_context);\n        return Ok(V3HubContinuationOwnership::RouteCodexLocalOwned);',
    diagnostic: /Req03 continuation classification/,
  },
  {
    name: 'Req04 execution bypass',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    from: 'let governed = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(classified);',
    to: 'let _bypass = "V3HubReqExecution05Planned";\n        let governed = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(classified);',
    diagnostic: /Req04 Chat Process governance/,
  },
  {
    name: 'dynamic hook discovery',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    from: 'pub fn compile_v3_hub_relay_request_hooks() -> V3HubRelayRequestHooks {\n    V3HubRelayRequestHooks { _sealed: () }\n}',
    to: 'pub fn compile_v3_hub_relay_request_hooks() -> V3HubRelayRequestHooks {\n    let _ = std::fs::read_dir(".");\n    V3HubRelayRequestHooks { _sealed: () }\n}',
    diagnostic: /dynamic|std::fs/,
  },
  {
    name: 'Req04 JSON round trip clone',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    from: 'let context = restore_local_context_from_store_at_req04(',
    to: 'let _copy = serde_json::to_string(store_scope).unwrap();\n            let context = restore_local_context_from_store_at_req04(',
    diagnostic: /Req04 local restore|relay_request\.rs/,
  },
  {
    name: 'servertool before restore',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
    from: 'let local_context = restore_local_context_at_req04(ownership, lookup)?;\n        if local_context.is_some()',
    to: 'run_servertool_profile(profile, &mut events)?;\n        let local_context = restore_local_context_at_req04(ownership, lookup)?;\n        if local_context.is_some()',
    diagnostic: /servertool ran before local continuation restore/,
  },
  {
    name: 'server escaped request owner',
    relative: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'use axum::body::{to_bytes, Body};',
    to: 'use axum::body::{to_bytes, Body};\nuse routecodex_v3_runtime::compile_v3_hub_relay_request_hooks;',
    diagnostic: /semantics escaped Hub/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-relay-request-red-'));
  try {
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-runtime/src'), join(root, 'v3/crates/routecodex-v3-runtime/src'), { recursive: true });
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-server/src'), join(root, 'v3/crates/routecodex-v3-server/src'), { recursive: true });
    cpSync(resolve(repoRoot, 'v3/crates/routecodex-v3-provider-responses/src'), join(root, 'v3/crates/routecodex-v3-provider-responses/src'), { recursive: true });
    const target = join(root, fixture.relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(fixture.from)) throw new Error(`${fixture.name}: fixture source missing`);
    writeFileSync(target, source.replace(fixture.from, fixture.to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-relay-request-semantics-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-relay-request-semantics-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
