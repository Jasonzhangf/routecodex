#!/usr/bin/env node
/**
 * P0 red gate for the Cordis production-mainline migration.
 * This gate is intentionally red until runtime-bin consumes the request-chain
 * output and stops owning protocol/router/wire business orchestration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeBin = fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime-bin/src/main.rs'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(root, 'crates/routecodex-v4-runtime/src/lib.rs'), 'utf8');
const providerSource = fs.readFileSync(path.join(root, 'crates/routecodex-v4-provider/src/lib.rs'), 'utf8');
// Test-only helpers are interleaved with production declarations.  Use the
// final test-module boundary instead of truncating the production file at the
// first cfg(test) helper.
const testModuleBoundary = runtimeBin.lastIndexOf('\n#[cfg(test)]');
const productionSource = testModuleBoundary >= 0
  ? runtimeBin.slice(0, testModuleBoundary)
  : runtimeBin;
const failures = [];

if (/execute_request_scoped_with_owner\([\s\S]*?\)\s*\.map_err/.test(productionSource)
    && !/let\s+request_report\s*=/.test(productionSource)) {
  failures.push('REQUEST_REPORT_DISCARDED: request chain report is not consumed by production path');
}
for (const symbol of [
  'project_chat_request_to_responses',
  'parse_responses_provider_payload',
  'build_protocol_wire',
  'build_retry_wire',
  'normalize_provider_response_with_instructions',
  'normalize_provider_response_for_relay',
  'normalize_provider_sse_frame',
  'normalize_provider_sse_frame_for_relay',
  'find_frame_end',
  'ResponsesSseStream',
  'select_product_target_with_unavailable',
  'send_openai_chat',
  'send_anthropic_messages',
  'send_responses',
]) {
  if (productionSource.includes(symbol)) failures.push(`RUNTIME_BIN_DIRECT_BUSINESS_HELPER: ${symbol}`);
}
if (!productionSource.includes('send_protocol(')
    && !productionSource.includes('dispatch_nonstream(')
    && !productionSource.includes('dispatch_streaming(')) {
  failures.push('PROVIDER_TRANSPORT_UNBOUND: runtime-bin must use provider-owned protocol dispatch');
}
if (!runtimeBin.includes('execute_provider_response_scoped')) {
  failures.push('RESPONSE_CHAIN_UNBOUND: runtime-bin does not consume response chain output');
}
if (!/execute_provider_response_scoped[\s\S]*?report\.client_frame/.test(productionSource)) {
  failures.push('RESPONSE_JSON_FRAME_DISCARDED: JSON response chain output is not consumed');
}
if (runtimeSource.includes('decode_provider_sse_frame(')
    || runtimeSource.includes('encode_client_sse_frame(')) {
  failures.push('SSE_SEMANTIC_BYPASS: runtime directly invokes SSE semantic codec outside NodePluginPlan');
}
if (productionSource.includes('SseIngressPlugin::new(')
    || productionSource.includes('SseEgressPlugin::new(')
    || !productionSource.includes('production_transport_pair(')) {
  failures.push('SSE_TRANSPORT_CONSTRUCTION_BYPASS: runtime-bin must consume the opaque SSE transport pair from the transport owner');
}
const sendResponsesStart = providerSource.indexOf('pub fn send_responses(');
const sendResponsesEnd = providerSource.indexOf('\npub fn send_responses_streaming(', sendResponsesStart);
const sendResponsesSource = providerSource.slice(sendResponsesStart, sendResponsesEnd);
if (/normalize_provider_(?:response|sse_frame)/.test(sendResponsesSource)) {
  failures.push('PROVIDER_TRANSPORT_SEMANTIC_BYPASS: send_responses performs response/SSE normalization before RespInbound');
}
const sseStreamStart = productionSource.indexOf('struct CordisSseTransportStream');
if (sseStreamStart < 0
    || !/execute_provider_response_scoped[\s\S]*?report\.client_frame/.test(productionSource.slice(sseStreamStart))) {
  failures.push('RESPONSE_SSE_FRAME_DISCARDED: SSE response chain output is not consumed');
}

if (failures.length > 0) {
  console.error('[V4-PRODUCTION-MAINLINE-RED] EXPECTED RED');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('[V4-PRODUCTION-MAINLINE-RED] GREEN');
