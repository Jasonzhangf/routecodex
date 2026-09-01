#!/usr/bin/env node
/**
 * M06-T01 request-mainline gate.
 *
 * The production request path must consume the standard request plugin owner
 * through the Cordis/runtime execution boundary.  This gate deliberately
 * rejects the legacy runtime-bin request helper path until that migration is
 * complete; it never accepts a second or fallback path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gatePath = fileURLToPath(import.meta.url);
const v4Root = path.resolve(path.dirname(gatePath), '..', '..');
const runtimeBin = fs.readFileSync(
  path.join(v4Root, 'crates/routecodex-v4-runtime-bin/src/main.rs'),
  'utf8',
);
const standardRoot = path.join(v4Root, 'crates/routecodex-v4-standard-plugins/src');
const requiredFiles = [
  'request_plugins.rs',
  'request_normalize.rs',
  'chat_to_responses.rs',
  'request_governance.rs',
  'provider_semantic.rs',
  'responses_wire_build.rs',
];
const failures = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(standardRoot, file))) {
    failures.push(`STANDARD_REQUEST_OWNER_MISSING: ${file}`);
  }
}

if (!runtimeBin.includes('routecodex_v4_standard_plugins')) {
  failures.push('PRODUCTION_REQUEST_OWNER_UNBOUND: runtime-bin does not bind standard request plugins');
}

for (const symbol of ['client_to_responses_request']) {
  if (new RegExp(`(?:fn|pub\\s+fn)\\s+${symbol}\\b`).test(runtimeBin)) {
    failures.push(`LEGACY_REQUEST_HELPER_PRESENT: ${symbol}`);
  }
}

if (failures.length > 0) {
  console.error('[V4-RESPONSES-REQUEST-001] FAIL');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log('[V4-RESPONSES-REQUEST-001] PASS standard request owner bound and legacy helpers absent');
