import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const functionMap = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');
const verificationMap = fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8');
const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'src/server/handlers/handler-response-sse.ts'), 'utf8');
const sseBridgeSource = fs.readFileSync(path.join(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'), 'utf8');
const sseSemanticsSource = fs.readFileSync(path.join(root, 'src/modules/llmswitch/bridge/responses-sse-semantics.ts'), 'utf8');
const clientProjectionSource = fs.readFileSync(path.join(root, 'src/modules/llmswitch/bridge/responses-client-projection.ts'), 'utf8');
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
expectContains(handlerSource, "from '../../modules/llmswitch/bridge/responses-client-projection.js'", 'handler-response-sse.ts must import the dedicated client projection facade');
expectContains(sseBridgeSource, '// feature_id: server.responses_sse_bridge_surface', 'responses-sse-bridge.ts must stay feature-anchored');

for (const forbiddenLocalDefinition of [
  'function inspectResponsesTerminalStateFromSseChunk(',
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

for (const forbiddenLifecycleBridgeExport of [
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

for (const forbiddenSseSemanticsExport of [
  'export function updateResponsesContractProbeFromSseChunkForHttp(',
  'export function inspectResponsesTerminalStateFromSseChunkForHttp(',
  'export function planResponsesStreamEndRepairForHttp(',
  'export function summarizeResponsesSseFrameForLogForHttp(',
  'export function resolveResponsesProviderProtocolHintFromSseFrameForHttp(',
]) {
  expectNotContains(
    sseSemanticsSource,
    forbiddenSseSemanticsExport,
    `responses-sse-semantics.ts must stay transport/projection-only: ${forbiddenSseSemanticsExport}`
  );
}

expectContains(
  clientProjectionSource,
  'export async function normalizeClientVisibleResponsesSseFrameForHttp(',
  'responses-client-projection.ts must own the thin TS client SSE projection shell'
);

for (const forbiddenClientProjectionExport of [
  'export async function projectResponsesSseFrameForClientForHttp(',
  'export async function normalizeResponsesSseFrameForClientForHttp(',
  'export function summarizeResponsesSseFrameForLogForHttp(',
  'export function resolveResponsesProviderProtocolHintFromSseFrameForHttp(',
]) {
  expectNotContains(
    clientProjectionSource,
    forbiddenClientProjectionExport,
    `responses-client-projection.ts must not own client projection or app-specific semantics: ${forbiddenClientProjectionExport}`
  );
}

expectNotContains(
  sseBridgeSource,
  'normalizeClientVisibleResponsesSseFrameForHttp',
  'responses-sse-bridge.ts must not keep client projection semantics'
);
expectNotContains(
  sseSemanticsSource,
  'response.required_action',
  'responses-sse-semantics.ts must not special-case response.required_action semantics'
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
