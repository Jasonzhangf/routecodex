#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const transportPath = 'v3/crates/routecodex-v3-provider-responses/src/transport.rs';
const testPath = 'v3/crates/routecodex-v3-provider-responses/tests/responses_websocket_v2.rs';
const serverPath = 'v3/crates/routecodex-v3-server/src/lib.rs';
const runtimePath = 'v3/crates/routecodex-v3-runtime/src/kernel.rs';
const resourceMapPath = 'docs/architecture/v3-resource-operation-map.yml';
const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlineMapPath = 'docs/architecture/v3-mainline-call-map.yml';
const verificationMapPath = 'docs/architecture/v3-verification-map.yml';
const packagePath = 'package.json';

const read = (path) => readFileSync(path, 'utf8');
const transport = read(transportPath);
const tests = read(testPath);
const server = read(serverPath);
const runtime = read(runtimePath);
const resourceMap = read(resourceMapPath);
const functionMap = read(functionMapPath);
const mainlineMap = read(mainlineMapPath);
const verificationMap = read(verificationMapPath);
const packageJson = JSON.parse(read(packagePath));
const failures = [];

for (const [owner, text, phrases] of [
  [transportPath, transport, [
    'const OPENAI_BETA_HEADER: &str = "openai-beta";',
    'const RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE: &str = "responses_websockets=2026-02-06";',
    'websocket_sessions: Arc<Mutex<BTreeMap<String, SharedResponsesWebSocket>>>',
    'session.lock_owned().await',
    'struct WebSocketSseState',
    'impl Drop for WebSocketSseState',
    'if !self.finished {',
    '*self.connection = None;',
    'state.finished = true;',
    'V3ProviderError::ClientDisconnect',
    'V3ProviderError::WebSocketProviderEvent',
    'connection closed before terminal response event',
    'handshake.headers_mut().insert(\n                OPENAI_BETA_HEADER,\n                HeaderValue::from_static(RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE),\n            );',
    'None => {\n                    *connection = None;\n                    return Err(websocket_protocol_error(',
  ]],
  [testPath, tests, [
    'RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE',
    'request.headers().get("openai-beta").unwrap()',
    'websocket_v2_reuses_one_connection_for_exact_incremental_continuation',
    'websocket_v2_sse_returns_first_frame_before_terminal_event',
    'websocket_v2_early_sse_drop_discards_connection_before_next_turn',
    'websocket_v2_provider_and_protocol_errors_discard_connection_before_reuse',
    'websocket_v2_codex_error_event_discards_connection_and_allows_client_retry_with_previous_response_id',
    'websocket_v2_read_cancellation_discards_connection_before_reuse',
    'websocket_v2_concurrent_streams_are_serialized_without_cross_frame_leakage',
    'websocket_v2_ping_pong_and_split_utf8_frames_preserve_one_terminal_event',
    'websocket_v2_cancellation_before_connect_or_reused_send_is_client_disconnect',
    'V3_WS_KEY_EARLY_DROP',
    'V3_WS_KEY_READ_CANCEL',
    'V3_WS_KEY_CONCURRENT',
    'status_code',
    'invalid_request_error',
  ]],
  [resourceMapPath, resourceMap, [
    'resource_id: v3.provider.responses_websocket_connection',
    'owner_node: ProviderResponsesTransport',
    'lifecycle: v3.provider.responses_websocket_v2_connection_local_cache',
    'binding_status: anchored',
  ]],
  [functionMapPath, functionMap, [
    'feature_id: v3.responses_websocket_v2_transport_hardening',
    'v3.provider.responses_websocket_connection',
    'RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE',
    'v3-ws2-01',
    'v3-ws2-02',
  ]],
  [mainlineMapPath, mainlineMap, [
    'chain_id: v3.responses.websocket_v2.transport_hardening',
    'OpenAI-Beta responses_websockets=2026-02-06',
    'step_id: v3-ws2-01',
    'step_id: v3-ws2-02',
  ]],
  [verificationMapPath, verificationMap, [
    'feature_id: v3.responses_websocket_v2_transport_hardening',
    'OpenAI-Beta responses_websockets=2026-02-06',
    'terminal drain permits exact-session reuse',
    'early drop error and disconnect discard the connection',
  ]],
]) {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
  }
}

for (const pattern of [
  /let\s+mut\s+\w*(?:frames|events|responses)\w*\s*=\s*Vec::new/,
  /fallback/i,
  /retry/i,
]) {
  if (pattern.test(transport)) failures.push(`${transportPath}: forbidden transport pattern ${pattern}`);
}

for (const script of [
  'test:v3-responses-websocket-v2-transport-hardening',
  'verify:v3-responses-websocket-v2-transport-hardening',
  'test:v3-responses-websocket-v2-transport-hardening-red-fixtures',
]) {
  if (!packageJson.scripts?.[script]) failures.push(`${packagePath}: missing script ${script}`);
}

const wsStart = transport.indexOf('async fn send_websocket_v2(');
const wsJsonEnd = transport.indexOf('fn anthropic_messages_url', wsStart);
const wsSseStart = transport.indexOf('fn websocket_sse_stream(');
const wsEnd = transport.indexOf('async fn read_response_body_bytes(');
if (wsStart < 0 || wsJsonEnd <= wsStart || wsSseStart <= wsJsonEnd || wsEnd <= wsSseStart) {
  failures.push(`${transportPath}: missing WebSocket transport owner boundary`);
} else {
  const wsJsonOwner = transport.slice(wsStart, wsJsonEnd);
  if (!/None => \{\s*\*connection = None;\s*return Err\(websocket_protocol_error\([\s\S]{0,240}"server event is missing type"/.test(wsJsonOwner)) {
    failures.push(`${transportPath}: JSON protocol error must discard connection`);
  }
  const wsOwner = `${transport.slice(wsStart, wsJsonEnd)}\n${transport.slice(wsSseStart, wsEnd)}`;
  for (const pattern of [
    /collect\s*::<\s*Vec/,
    /let\s+mut\s+\w*(?:frames|events|responses)\w*\s*=\s*Vec::new/,
    /retry/i,
    /fallback/i,
    /send_http\s*\(/,
    /reqwest::/,
    /servertool|required_action|tool_call|local_materiali[sz]ation|restore_history/i,
  ]) {
    if (pattern.test(wsOwner)) failures.push(`${transportPath}: forbidden WebSocket owner pattern ${pattern}`);
  }
  for (const phrase of [
    'fn websocket_error_status(server_event: &Value) -> Option<u16>',
    '.or_else(|| server_event.get("status_code"))',
    'fn websocket_error_code(error: &Value) -> Option<String>',
    '.or_else(|| error.get("type"))',
  ]) {
    if (!wsOwner.includes(phrase)) {
      failures.push(`${transportPath}: missing Codex WebSocket error parsing phrase ${phrase}`);
    }
  }
}

for (const [owner, text] of [[serverPath, server], [runtimePath, runtime]]) {
  for (const pattern of [/websocket_sessions/, /SharedResponsesWebSocket/, /WebSocketStream</, /connect_async\s*\(/]) {
    if (pattern.test(text)) failures.push(`${owner}: forbidden socket owner pattern ${pattern}`);
  }
}

if (failures.length) {
  console.error('[verify:v3-responses-websocket-v2-transport-hardening] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-responses-websocket-v2-transport-hardening] ok');
