#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const path = 'v3/crates/routecodex-v3-runtime/src/hooks.rs';
const text = readFileSync(path, 'utf8');
const kernel = readFileSync('v3/crates/routecodex-v3-runtime/src/kernel.rs', 'utf8');
const required = [
  'ResponsesDirectRouteHook',
  'ResponsesDirectRequestProjectionHook',
  'ResponsesDirectProviderTransportHook',
  'ResponsesDirectResponseProjectionHook',
  'ResponsesDirectErrorHook',
];
const missing = required.filter((hook) => !text.includes(hook));
const forbidden = [/std::fs/, /libloading/, /discover/i, /dynamic/i].filter((pattern) => pattern.test(text));
const requiredRuntimeCalls = [
  'run_route',
  'run_request_projection',
  'run_provider_transport',
  'run_response_projection',
  'run_error',
];
const missingRuntimeCalls = requiredRuntimeCalls.filter((call) => !kernel.includes(call));
if (missing.length || forbidden.length || missingRuntimeCalls.length) {
  console.error('[verify:v3-static-hook-registry] failed');
  for (const hook of missing) console.error('- missing ' + hook);
  for (const pattern of forbidden) console.error('- forbidden ' + pattern);
  for (const call of missingRuntimeCalls) console.error('- runtime does not execute ' + call);
  process.exit(1);
}
console.log('[verify:v3-static-hook-registry] ok');
