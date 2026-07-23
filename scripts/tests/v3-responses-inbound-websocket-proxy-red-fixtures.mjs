#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-responses-inbound-websocket-proxy.mjs');
const copied = [
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs',
  'v3/crates/routecodex-v3-server/Cargo.toml',
  'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.responses_inbound_websocket_proxy.mainline.yml',
  'docs/architecture/wiki/v3-responses-inbound-websocket-proxy.md',
  'package.json',
];
const cases = [
  {
    name: 'route loses WebSocket GET',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'post(pending_endpoint).get(responses_websocket_endpoint)',
    to: 'post(pending_endpoint)',
    diagnostic: /responses_websocket_endpoint|route/,
  },
  {
    name: 'beta header validation removed',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'OpenAI-Beta: responses_websockets=2026-02-06 is required for /v1/responses WebSocket',
    to: 'responses websocket beta optional',
    diagnostic: /OpenAI-Beta|responses_websockets/,
  },
  {
    name: 'Server owns provider socket',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: '    ws: Option<WebSocketUpgrade>,\n) -> Response<Body> {\n',
    to: '    ws: Option<WebSocketUpgrade>,\n) -> Response<Body> {\n    let _forbidden_provider_state = "SharedResponsesWebSocket";\n',
    diagnostic: /SharedResponsesWebSocket|socket/,
  },
  {
    name: 'HTTP fallback added',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: '    ws: Option<WebSocketUpgrade>,\n) -> Response<Body> {\n',
    to: '    ws: Option<WebSocketUpgrade>,\n) -> Response<Body> {\n    let _http_fallback_retry = "http_fallback";\n',
    diagnostic: /fallback|retry/,
  },
  {
    name: 'SSE event accumulation added',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'async fn send_responses_websocket_sse_stream(',
    to: 'fn forbidden_collect() { let mut events = Vec::new(); events.push(1); }\nasync fn send_responses_websocket_sse_stream(',
    diagnostic: /Vec|events/,
  },
  {
    name: 'nested response shape accepted',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'response.create must be a flat event; nested response payload is unsupported',
    to: 'response.create nested response payload accepted',
    diagnostic: /flat event|nested response/,
  },
  {
    name: 'client disconnect polling removed',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'client_message = socket.next() =>',
    to: 'provider_chunk_only = stream.next() =>',
    diagnostic: /client_message|socket\.next|client disconnect polling/,
  },

  {
    name: 'Relay WebSocket dispatch removed',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'async fn execute_responses_relay_websocket_output(',
    to: 'async fn execute_responses_relay_websocket_output_removed(',
    diagnostic: /execute_responses_relay_websocket_output|Relay Runtime/,
  },
  {
    name: 'runtime SSE decode error hidden',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    from: 'runtime SSE decode failed',
    to: 'runtime stream closed',
    diagnostic: /runtime SSE decode failed|runtime SSE decode guards/,
  },
  {
    name: 'malformed client event test removed',
    file: 'v3/crates/routecodex-v3-server/tests/multi_listener_server.rs',
    from: 'responses_inbound_websocket_rejects_malformed_client_event_without_provider_send',
    to: 'responses_inbound_websocket_malformed_case_removed',
    diagnostic: /malformed|provider send/,
  },
  {
    name: 'map owner removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: '      - responses_websocket_endpoint',
    to: '      - inbound_ws_entry_symbol_removed',
    diagnostic: /responses_websocket_endpoint/,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-inbound-ws-red-'));
  try {
    for (const path of copied) {
      const destination = resolve(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(repo, path), destination);
    }
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(testCase.from)) throw new Error(testCase.name + ': mutation source missing');
    writeFileSync(target, source.replace(testCase.from, testCase.to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    if (result.status === 0) failures.push(testCase.name + ': verifier unexpectedly passed');
    else if (!testCase.diagnostic.test(output)) failures.push(testCase.name + ': wrong diagnostic: ' + output.slice(-500));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-responses-inbound-websocket-proxy-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[test:v3-responses-inbound-websocket-proxy-red-fixtures] ok (' + cases.length + ' forbidden mutations rejected)');
