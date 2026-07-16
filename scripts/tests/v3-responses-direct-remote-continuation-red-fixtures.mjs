#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-responses-direct-remote-continuation.mjs');
const runtime = 'v3/crates/routecodex-v3-runtime/src/kernel.rs';
const response = 'v3/crates/routecodex-v3-runtime/src/shared.rs';
const server = 'v3/crates/routecodex-v3-server/src/lib.rs';
const configValidate = 'v3/crates/routecodex-v3-config/src/validate.rs';
const providerTransport = 'v3/crates/routecodex-v3-provider-responses/src/transport.rs';
const cases = [
  ['Req03 load removed', runtime, '.load_for_req03(response_id, &scope.key, now_epoch_ms)', '.load(response_id)', /load_for_req03/],
  ['Default transport session state removed', runtime, 'static DEFAULT_RESPONSES_TRANSPORT', 'static REMOVED_DEFAULT_RESPONSES_TRANSPORT', /DEFAULT_RESPONSES_TRANSPORT/],
  ['second response exit', runtime, 'fn release_terminal_failure_locator(', 'async fn execute_selected_continuation() {}\nfn release_terminal_failure_locator(', /execute_selected_continuation/],
  ['Router reentry marker', runtime, 'trace.push("V3HubReqTarget06Resolved");', 'trace.push("V3HubReqTarget06Resolved");\n        let fallback_router = V3VirtualRouter::default();', /fallback/],
  ['control payload leak', runtime, 'let policy = hook_registry.run_route(selected, &standardized);', 'let mut policy = hook_registry.run_route(selected, &standardized);\n        policy.request_body["provider_id"] = serde_json::json!("leak");', /provider_id/],
  ['non-atomic Resp04 rebind', runtime, 'store.rebind_for_resp04(previous_response_id, input)', '{ store.release(previous_response_id); store.commit(input) }', /rebind_for_resp04/],
  ['SSE stream materialized before projection', response, 'let provider_body = raw.into_body();', 'let body_bytes = raw.into_body_bytes().await.unwrap();\n    let provider_body = V3ProviderResponseBody::Json(body_bytes);', /into_body_bytes/],
  ['structured SSE frame observation removed', response, 'observe_sse_frame_remote_continuation(frame.frame().fields(), pending_response_id)?;', '// structured frame observation removed', /observe_sse_frame_remote_continuation/],
  ['Server store owner', server, 'fn build_responses_direct_continuation_scope(', 'fn forbidden(store: V3RemoteContinuationStore) {}\nfn build_responses_direct_continuation_scope(', /V3RemoteContinuationStore/],
  ['HTTP-only remote continuation accepted', configValidate, 'let responses = compile_provider_responses(&id, provider.responses, &models)?;', 'let responses = provider.responses;', /compile_provider_responses/],
  ['WebSocket stream field leaks into event', providerTransport, 'event.remove("stream");', '// stream field leak', /event\.remove\("stream"\)/],
  ['WebSocket SSE materialization', providerTransport, 'fn websocket_sse_stream(', 'fn materialized() { let mut sse_frames = Vec::new(); sse_frames.push(Vec::<u8>::new()); }\nfn websocket_sse_stream(', /sse_frames/],
  ['WebSocket fallback marker', providerTransport, 'fn websocket_sse_stream(', 'fn fallback_http_retry() {}\nfn websocket_sse_stream(', /fallback/i],
];
const copied = [
  runtime,
  'v3/crates/routecodex-v3-runtime/src/remote_continuation.rs',
  'v3/crates/routecodex-v3-runtime/src/shared.rs',
  'v3/crates/routecodex-v3-config/src/types.rs',
  configValidate,
  providerTransport,
  'v3/crates/routecodex-v3-target/src/lib.rs',
  server,
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
  'v3/crates/routecodex-v3-config/tests/config_v3_contract.rs',
  'v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs',
  'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs',
  'docs/goals/v3-responses-direct-remote-continuation-integration-test-design.md',
  'docs/goals/v3-responses-direct-remote-continuation-integration-plan.md',
];
const failures = [];
for (const [name, relative, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-rci-red-'));
  try {
    for (const path of copied) {
      const destination = resolve(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repo, path), destination);
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
  console.error('[test:v3-responses-direct-remote-continuation-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-responses-direct-remote-continuation-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
