import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const functionMap = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');
const verificationMap = fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8');
const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
const sseBridgeSource = fs.readFileSync(path.join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'), 'utf8');
const sseTransportSource = fs.readFileSync(path.join(root, 'src/modules/llmswitch/bridge/responses-sse-transport.ts'), 'utf8');
const responseLifecycleBridgeSource = fs.readFileSync(
  path.join(root, 'src/modules/llmswitch/bridge/responses-response-bridge.ts'),
  'utf8'
);

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

function expectNotContains(source, needle, message) {
  if (source.includes(needle)) {
    failures.push(message);
  }
}

const featureId = 'server.responses_sse_bridge_surface';
const functionSection = sectionForFeature(functionMap, featureId);
const verificationSection = sectionForFeature(verificationMap, featureId);

expectContains(functionSection, 'locked business module', 'function-map: SSE bridge summary must declare the business-module boundary');
expectContains(functionSection, 'tests/red-tests/server_responses_sse_business_module_contract.test.ts', 'function-map: SSE bridge required_tests must include the business-module contract test');
expectContains(functionSection, 'npm run verify:responses-sse-business-module', 'function-map: SSE bridge required_gates must include verify:responses-sse-business-module');
expectContains(verificationSection, 'tests/red-tests/server_responses_sse_business_module_contract.test.ts', 'verification-map: SSE bridge contract tests must include the business-module contract test');
expectContains(verificationSection, 'npm run verify:responses-sse-business-module', 'verification-map: SSE bridge smoke must include verify:responses-sse-business-module');

expectContains(packageJson, '"verify:responses-sse-business-module"', 'package.json must define verify:responses-sse-business-module');
expectContains(packageJson, 'npm run verify:responses-sse-business-module', 'package.json verification wiring must execute verify:responses-sse-business-module');

expectContains(handlerSource, "from '../../modules/llmswitch/bridge/responses-sse-bridge.js'", 'handler-response-sse.ts must import the dedicated SSE bridge facade');
expectContains(sseBridgeSource, '// feature_id: server.responses_sse_bridge_surface', 'responses-sse-bridge.ts must stay feature-anchored');
expectContains(sseTransportSource, 'export function buildClientSseKeepaliveFrameForHttp(', 'responses-sse-transport.ts must own keepalive framing');
expectContains(sseTransportSource, 'export function shouldDropClientSseFrameForHttp(', 'responses-sse-transport.ts must own transport-only frame drop policy');
expectNotContains(responseLifecycleBridgeSource, 'resolveResponsesRequestContextForHttp', 'responses-response-bridge.ts must not keep request-context facade salvage');
expectNotContains(responseLifecycleBridgeSource, 'shouldDispatchResponsesSseToClientForHttp', 'responses-response-bridge.ts must not keep SSE dispatch facade salvage');
expectNotContains(responseLifecycleBridgeSource, 'buildClientSseKeepaliveFrameForHttp', 'responses-response-bridge.ts must not own keepalive framing');
expectNotContains(sseBridgeSource, 'resolveResponsesRequestContextForHttp', 'responses-sse-bridge.ts must not re-export request-context facade salvage');
expectNotContains(sseBridgeSource, 'shouldDispatchResponsesSseToClientForHttp', 'responses-sse-bridge.ts must not re-export SSE dispatch facade salvage');

for (const forbiddenLocalDefinition of [
  'async function streamResponsesJsonAsSse(',
  'async function streamChatCompletionsJsonAsSse(',
  'async function dispatchResponsesJsonAsSse(',
  'function inspectResponsesTerminalStateFromSseChunk(',
  'function hasResponsesTerminalSseMarker(',
  'sawTerminalEvent',
  'terminalScanBuffer',
  'function buildStructuredSseErrorPayloadForHttp(',
  'function extractStructuredSseErrorPayload(',
  'function sendStructuredSseError(',
  'structured_error_passthrough',
  'function buildTransportLocalSseErrorPayload(',
  'function resolveResponsesRequestContextForHttp(',
  'function shouldDispatchResponsesSseToClientForHttp(',
  'function buildResponsesTerminalSseFramesFromProbe(',
  'function planResponsesStreamEndRepair(',
  'function shouldRequireResponsesTerminalEvent(',
  'function resolveResponsesTerminalProbeFinishReason(',
  'function updateResponsesContractProbeFromSseChunk(',
  'function buildResponsesSseErrorPayload(',
  'function buildResponsesStreamIncompleteErrorPayload(',
  'deriveFinishReason(',
]) {
  expectNotContains(
    handlerSource,
    forbiddenLocalDefinition,
    `handler-response-sse.ts must not re-own SSE protocol semantics: ${forbiddenLocalDefinition}`
  );
}

for (const forbiddenHandlerJsonSseBridge of [
  'createResponsesJsonToSseConverterForHttp',
  'createChatJsonToSseConverterForHttp',
  'buildResponsesPayloadFromChatForHttp',
]) {
  if (handlerSource.includes(forbiddenHandlerJsonSseBridge)) {
    failures.push(`handler-response-sse.ts must not keep force-SSE JSON->SSE fallback bridge: ${forbiddenHandlerJsonSseBridge}`);
  }
}

for (const forbiddenSseBridgeJsonFallbackSurface of [
  'createResponsesJsonToSseConverterForHttp',
  'createChatJsonToSseConverterForHttp',
  'buildResponsesPayloadFromChatForHttp',
  'prepareResponsesJsonBodyForSseBridgeForHttp',
]) {
  if (sseBridgeSource.includes(forbiddenSseBridgeJsonFallbackSurface)) {
    failures.push(`responses-sse-bridge.ts must not export JSON->SSE fallback surface: ${forbiddenSseBridgeJsonFallbackSurface}`);
  }
}

for (const forbiddenLifecycleBridgeExport of [
  'export function planResponsesContinuationCloseActionForHttp(',
  'function isDirectResponsesToolCallContinuationForHttp(',
  'export async function prepareResponsesJsonBodyForSseBridgeForHttp(',
  'export function normalizeResponsesJsonBodyForHttp(',
  'function ensureResponsesJsonToSseRequiredFieldsForHttp(',
  'export function buildResponsesSseErrorPayloadForHttp(',
  'export function buildResponsesStructuredSseErrorPayloadForHttp(',
  'export function buildResponsesMissingSseBridgeErrorPayloadForHttp(',
  'export function inspectResponsesTerminalStateFromSseChunkForHttp(',
  'export function planResponsesStreamEndRepairForHttp(',
  'export async function createResponsesJsonToSseConverterForHttp(',
  'export async function projectResponsesSseFrameForClientForHttp(',
  'export async function normalizeResponsesSseFrameForClientForHttp(',
]) {
  expectNotContains(
    responseLifecycleBridgeSource,
    forbiddenLifecycleBridgeExport,
    `responses-response-bridge.ts must not own SSE semantics: ${forbiddenLifecycleBridgeExport}`
  );
}

expectNotContains(
  sseBridgeSource,
  'normalizeClientVisibleResponsesSseFrameForHttp',
  'responses-sse-bridge.ts must not keep client projection semantics'
);
expectNotContains(
  sseBridgeSource,
  'reprojectDirectChatToolCallStreamForHttp',
  'responses-sse-bridge.ts must not own direct chat tool-call stream reprojection; response projection belongs to Rust owner before transport'
);
expectNotContains(
  responseLifecycleBridgeSource,
  'normalizeChatUsagePayloadForHttp',
  'responses-response-bridge.ts must not own chat usage normalization policy; usage semantics belong to response/runtime owner before transport'
);
expectNotContains(
  responseLifecycleBridgeSource,
  'shouldClearResponsesConversationOnClientCloseForHttp',
  'responses-response-bridge.ts must not own client-close conversation cleanup policy; continuation lifecycle belongs to Chat Process/store owner'
);
expectNotContains(
  responseLifecycleBridgeSource,
  'shouldClearResponsesConversationOnFailureForHttp',
  'responses-response-bridge.ts must not own failure conversation cleanup policy; continuation lifecycle belongs to Chat Process/store owner'
);
expectNotContains(
  responseLifecycleBridgeSource,
  'resolveRelayResponsesClientSseStreamForHttp',
  'responses-response-bridge.ts must not own relay Responses SSE reprojection policy; client projection belongs to Rust owner before transport'
);
expectNotContains(
  sseTransportSource,
  'response.required_action',
  'responses-sse-transport.ts must not special-case response.required_action semantics'
);
expectNotContains(
  responseLifecycleBridgeSource,
  "record.object === 'chat.completion'",
  'responses-response-bridge.ts must not convert chat.completion into Responses payload; projection belongs to Rust RespOutbound owner'
);
expectNotContains(
  responseLifecycleBridgeSource,
  'isToolCallContinuationResponseNative(',
  'responses-response-bridge.ts must not probe response body for continuation persist/clear decisions'
);
expectNotContains(
  handlerSource,
  'shouldDropClientSseFrameForHttp(frame, entryEndpoint)',
  'handler-response-sse.ts must not decide semantic frame drop in the transport loop; SSE bridge may only frame already-finalized payload'
);

for (const forbiddenDirectNativeImport of [
  'updateResponsesContractProbeFromSseChunkNative',
  'buildResponsesTerminalSseFramesFromProbeNative',
  'createResponsesJsonToSseConverter',
  'projectResponsesSseFrameForClientNative',
]) {
  const nativeImportPattern = new RegExp(
    String.raw`import\s*\{[^}]*${forbiddenDirectNativeImport}[^}]*\}\s*from\s*['"]\.\.\/\.\.\/modules\/llmswitch\/bridge(?:\/index)?\.js['"]`,
    'm'
  );
  if (nativeImportPattern.test(handlerSource)) {
    failures.push(`handler-response-sse.ts must not bypass responses-sse-bridge facade via ${forbiddenDirectNativeImport}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-sse-business-module] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:responses-sse-business-module] ok');
console.log('- /v1/responses SSE surface remains transport/projection-only; terminal/probe/repair semantics are outside SSE owner');
