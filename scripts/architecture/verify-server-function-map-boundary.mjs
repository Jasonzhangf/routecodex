import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const functionMap = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');
const verificationMap = fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

const failures = [];

function sectionForFeature(source, featureId) {
  const marker = `- feature_id: ${featureId}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    return '';
  }
  const next = source.indexOf('\n  - feature_id:', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function expectContains(source, needle, message) {
  if (!source.includes(needle)) {
    failures.push(message);
  }
}

const handlerFeature = sectionForFeature(functionMap, 'server.responses_handler_family');
const requestBridgeFeature = sectionForFeature(functionMap, 'server.responses_request_handler_bridge_surface');
const responseSseBridgeFeature = sectionForFeature(functionMap, 'server.responses_sse_bridge_surface');
const responseBridgeFeature = sectionForFeature(functionMap, 'server.responses_response_handler_bridge_surface');

const handlerVerification = sectionForFeature(verificationMap, 'server.responses_handler_family');
const requestBridgeVerification = sectionForFeature(verificationMap, 'server.responses_request_handler_bridge_surface');
const responseSseBridgeVerification = sectionForFeature(verificationMap, 'server.responses_sse_bridge_surface');
const responseBridgeVerification = sectionForFeature(verificationMap, 'server.responses_response_handler_bridge_surface');

expectContains(handlerFeature, 'HTTP transport adapters only', 'function-map: server.responses_handler_family must say HTTP transport adapters only');
expectContains(handlerFeature, 'no protocol parsing, protocol conversion, protocol repair, or protocol projection', 'function-map: server.responses_handler_family must forbid protocol semantics in server handlers');

expectContains(requestBridgeFeature, 'opaque request facade only', 'function-map: server.responses_request_handler_bridge_surface must say opaque request facade only');
expectContains(requestBridgeFeature, 'no protocol parsing, protocol conversion, tool-shape normalization, or submit/protocol branching in TS', 'function-map: request bridge notes must forbid TS protocol semantics');
expectContains(requestBridgeFeature, 'scripts/architecture/verify-server-function-map-boundary.mjs', 'function-map: request bridge allowed_paths must include verify-server-function-map-boundary.mjs');

expectContains(responseSseBridgeFeature, 'opaque SSE/body handoff facade only', 'function-map: server.responses_sse_bridge_surface must say opaque SSE/body handoff facade only');
expectContains(responseSseBridgeFeature, 'no SSE event allowlist, required_action parsing, response payload rebuilding, or protocol projection in TS', 'function-map: SSE bridge notes must forbid TS response protocol semantics');
expectContains(responseSseBridgeFeature, 'scripts/architecture/verify-server-function-map-boundary.mjs', 'function-map: SSE bridge allowed_paths must include verify-server-function-map-boundary.mjs');
expectContains(responseBridgeFeature, 'opaque continuation/conversation facade only', 'function-map: server.responses_response_handler_bridge_surface must say opaque continuation/conversation facade only');
expectContains(responseBridgeFeature, 'response-id rebinding, continuation retention/finalization, or conversation clear-policy semantics', 'function-map: lifecycle bridge notes must forbid handler-owned lifecycle semantics');
expectContains(responseBridgeFeature, 'scripts/architecture/verify-server-function-map-boundary.mjs', 'function-map: lifecycle bridge allowed_paths must include verify-server-function-map-boundary.mjs');

for (const section of [handlerVerification, requestBridgeVerification, responseSseBridgeVerification, responseBridgeVerification]) {
  expectContains(section, 'npm run verify:server-function-map-boundary', 'verification-map: server feature must require verify:server-function-map-boundary');
}

expectContains(pkg, '"verify:server-function-map-boundary"', 'package.json must define verify:server-function-map-boundary');
expectContains(pkg, 'npm run verify:server-function-map-boundary', 'package.json gate wiring must run verify:server-function-map-boundary');

if (failures.length > 0) {
  console.error('[verify:server-function-map-boundary] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:server-function-map-boundary] ok');
console.log('- checked server handler / bridge function-map boundary docs and gate wiring');
