#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const admissionRoot = resolve(v3Root, 'build-contracts', 'architecture-admission', 'repo');
const verifier = resolve(v3Root, 'scripts/architecture/verify-v3-responses-websocket-v2-transport-hardening.mjs');
const transport = 'v3/crates/routecodex-v3-provider-responses/src/transport.rs';
const websocket = 'v3/crates/routecodex-v3-provider-responses/src/transport/websocket.rs';
const tests = 'v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs';
const server = 'v3/crates/routecodex-v3-server/src/lib.rs';
const copied = [
  transport,
  websocket,
  tests,
  server,
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'v3/package.json',
];
const cases = [
  ['early drop keeps socket', websocket, '*self.connection = None;', '// mutated: keep socket', /connection/],
  ['JSON missing type keeps socket', transport, 'None => {\n                    *connection = None;\n                    return Err(websocket_protocol_error(', 'None => {\n                    return Err(websocket_protocol_error(', /connection/],
  ['WebSocket event accumulation', transport, '        let session_key = format!(', '        let mut response_events = Vec::new(); response_events.push(1);\n        let session_key = format!(', /Vec/],
  ['WebSocket JSON accumulator removed', websocket, 'struct V3ResponsesWebSocketProtocolAggregate', 'struct V3WsProtocolAggregateRemoved', /V3ResponsesWebSocketProtocolAggregate/],
  ['ASXS-shaped function-call aggregation test removed', tests, 'websocket_v2_json_aggregates_function_call_item_when_terminal_output_is_empty', 'websocket_v2_json_aggregation_case_removed', /json_aggregates_function_call_item|terminal_output_is_empty|V3_WS_KEY_ASXS_SHAPE/],
  ['WebSocket beta header removed', transport, 'handshake.headers_mut().insert(\n                OPENAI_BETA_HEADER,\n                HeaderValue::from_static(RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE),\n            );', '// mutated: missing beta header', /OPENAI_BETA_HEADER|responses_websockets/],
  ['HTTP retry fallback', transport, '        let session_key = format!(', '        let _fallback_http_retry = true;\n        let session_key = format!(', /fallback/i],
  ['Codex status_code parsing removed', websocket, '.or_else(|| server_event.get("status_code"))', '', /status_code/],
  ['Codex error type parsing removed', websocket, '.or_else(|| error.get("type"))', '', /error parsing|error\.get\("type"\)/],
  ['Server socket owner', server, 'pub struct V3ServerAggregateHandle {', 'struct SharedResponsesWebSocket;\npub struct V3ServerAggregateHandle {', /socket owner|SharedResponsesWebSocket/],
  ['concurrency case removed', tests, 'websocket_v2_concurrent_streams_are_serialized_without_cross_frame_leakage', 'websocket_v2_concurrency_case_removed', /concurrent/],
];

const failures = [];
for (const [name, relative, from, to, diagnostic] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-ws2-hardening-red-'));
  try {
    for (const path of copied) {
      const destination = resolve(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      const source = path.startsWith('v3/')
        ? resolve(v3Root, path.slice(3))
        : resolve(admissionRoot, path);
      cpSync(source, destination);
    }
    const target = resolve(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-responses-websocket-v2-transport-hardening-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-responses-websocket-v2-transport-hardening-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
