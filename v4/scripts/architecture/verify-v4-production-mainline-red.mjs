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
const productionSource = runtimeBin.split('#[cfg(test)]', 1)[0];
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
]) {
  if (productionSource.includes(symbol)) failures.push(`RUNTIME_BIN_DIRECT_BUSINESS_HELPER: ${symbol}`);
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
