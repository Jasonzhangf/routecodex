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
const failures = [];

if (/execute_request_scoped_with_owner\([\s\S]*?\)\s*\.map_err/.test(runtimeBin)
    && !/let\s+request_report\s*=/.test(runtimeBin)) {
  failures.push('REQUEST_REPORT_DISCARDED: request chain report is not consumed by production path');
}
for (const symbol of [
  'project_chat_request_to_responses',
  'build_protocol_wire',
  'select_product_target_with_unavailable',
]) {
  if (runtimeBin.includes(symbol)) failures.push(`RUNTIME_BIN_DIRECT_BUSINESS_HELPER: ${symbol}`);
}
if (!runtimeBin.includes('execute_provider_response_scoped')) {
  failures.push('RESPONSE_CHAIN_UNBOUND: runtime-bin does not consume response chain output');
}

if (failures.length === 0) {
  console.error('[V4-PRODUCTION-MAINLINE-RED] unexpectedly green: migration red fixtures no longer detect bypass');
  process.exit(1);
}
console.error('[V4-PRODUCTION-MAINLINE-RED] EXPECTED RED');
for (const failure of failures) console.error(failure);
process.exit(1);
