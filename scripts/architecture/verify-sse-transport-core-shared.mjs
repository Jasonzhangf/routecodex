import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const coreCargo = 'sharedmodule/llmswitch-core/rust-core/crates/sse-transport-core/Cargo.toml';
const coreSource = 'sharedmodule/llmswitch-core/rust-core/crates/sse-transport-core/src/lib.rs';
const v2Workspace = 'sharedmodule/llmswitch-core/rust-core/Cargo.toml';
const v2Cargo = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml';
const v2Adapter = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_sse_stream_sniffer.rs';
const v3Cargo = 'v3/crates/routecodex-v3-provider-responses/Cargo.toml';
const v3Adapter = 'v3/crates/routecodex-v3-provider-responses/src/shared.rs';
const v3Projection = 'v3/crates/routecodex-v3-runtime/src/shared.rs';
const v3Nodes = 'v3/crates/routecodex-v3-runtime/src/nodes.rs';
const v3Server = 'v3/crates/routecodex-v3-server/src/lib.rs';

for (const file of [coreCargo, coreSource, v2Workspace, v2Cargo, v2Adapter, v3Cargo, v3Adapter, v3Projection, v3Nodes, v3Server]) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`${file}: required shared SSE transport surface missing`);
}

if (failures.length === 0) {
  const core = read(coreSource);
  const productionCore = core.split('#[cfg(test)]')[0];
  for (const marker of [
    'SseTransportIn01RawChunk',
    'SseTransportIn02DecodedFrame',
    'SseTransportIn03ValidatedFrameStream',
    'SseTransportOut04EncodedChunk',
    'SseTransportError',
    'SseIncrementalDecoder',
    'build_sse_transport_in_01_raw_chunk',
    'build_sse_transport_out_04_from_sse_transport_in_03',
  ]) {
    if (!productionCore.includes(marker)) failures.push(`${coreSource}: missing ${marker}`);
  }
  for (const forbidden of [
    'response.completed',
    'required_action',
    'tool_call',
    'continuation',
    'servertool',
    'stopless',
    'serde_json',
    'provider_id',
  ]) {
    if (productionCore.includes(forbidden)) failures.push(`${coreSource}: transport core owns forbidden business marker ${forbidden}`);
  }

  const v2WorkspaceSource = read(v2Workspace);
  const v2CargoSource = read(v2Cargo);
  const v2AdapterSource = read(v2Adapter);
  const v3CargoSource = read(v3Cargo);
  const v3AdapterSource = read(v3Adapter);
  if (!v2WorkspaceSource.includes('"crates/sse-transport-core"')) failures.push(`${v2Workspace}: shared crate is not a workspace member`);
  if (!v2CargoSource.includes('sse-transport-core = { path = "../sse-transport-core" }')) failures.push(`${v2Cargo}: V2 Rust adapter does not depend on shared core`);
  if (!v3CargoSource.includes('sse-transport-core = { path = "../../../sharedmodule/llmswitch-core/rust-core/crates/sse-transport-core" }')) failures.push(`${v3Cargo}: V3 adapter does not depend on shared core`);
  for (const [file, source] of [[v2Adapter, v2AdapterSource], [v3Adapter, v3AdapterSource]]) {
    if (!source.includes('build_sse_transport_in_01_raw_chunk')) failures.push(`${file}: adapter bypasses RawChunk builder`);
    if (!source.includes('build_sse_transport_out_04_from_sse_transport_in_03')) failures.push(`${file}: adapter bypasses EncodedChunk builder`);
  }
  for (const forbidden of ['fn parse_sse_line(', 'fn assemble_sse_event(', 'assemble_sse_event_from_lines_json']) {
    if (v2AdapterSource.includes(forbidden)) failures.push(`${v2Adapter}: duplicate V2 SSE framing parser residue ${forbidden}`);
  }
  for (const forbidden of ['fn event_end(', 'fn validate_sse_event(', '.windows(2)', '.windows(4)']) {
    if (v3AdapterSource.includes(forbidden)) failures.push(`${v3Adapter}: duplicate SSE parser residue ${forbidden}`);
  }

  const v3ProjectionSource = read(v3Projection);
  const v3NodesSource = read(v3Nodes);
  const v3ServerSource = read(v3Server);
  for (const [pattern, reason] of [
    [/raw\.into_body_bytes\(\)\.await/, 'raw response body materialization'],
    [/let\s+mut\s+client_bytes\s*=\s*Vec::new\(\)/, 'client SSE byte accumulator'],
    [/client_bytes\.extend_from_slice\(/, 'client SSE full-stream append'],
    [/V3ClientBody::Bytes\(client_bytes\)/, 'SSE projected as complete byte body'],
  ]) {
    if (pattern.test(v3ProjectionSource)) failures.push(v3Projection + ': V3 SSE projection still materializes the complete provider stream via ' + reason);
  }
  if (!/V3ClientBody[\s\S]*Sse\(/.test(v3NodesSource)) {
    failures.push(v3Nodes + ': V3 client payload contract lacks a streaming SSE body variant');
  }
  const anthropicProjection = slice(v3ServerSource, 'fn anthropic_relay_output_response', 'async fn debug_status');
  for (const [pattern, reason] of [
    [/let\s+mut\s+bytes\s*=\s*Vec::new\(\)/, 'Anthropic server byte accumulator'],
    [/bytes\.extend_from_slice\(/, 'Anthropic server full-response append'],
    [/format!\("event: \{name\}\\ndata: \{data\}\\n\\n"\)/, 'manual SSE writer'],
    [/Body::from\(body\)/, 'Anthropic SSE Body::from materialized bytes'],
    [/unwrap_or_default\(\)/, 'Anthropic SSE silently converts missing events to an empty stream'],
    [/Ok\(None\)/, 'Anthropic SSE silently skips malformed events'],
  ]) {
    if (pattern.test(anthropicProjection)) failures.push(v3Server + ': Anthropic Relay SSE output bypasses shared streaming encoder via ' + reason);
  }
}

if (failures.length > 0) {
  console.error('[verify:sse-transport-core-shared] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:sse-transport-core-shared] ok');
console.log('- V2 and V3 use one Rust SSE framing owner');
console.log('- transport core contains no business semantics or full-stream materialization');

function slice(text, from, to) {
  const start = text.indexOf(from);
  if (start < 0) return '';
  const end = text.indexOf(to, start + from.length);
  return end >= 0 ? text.slice(start, end) : text.slice(start);
}
