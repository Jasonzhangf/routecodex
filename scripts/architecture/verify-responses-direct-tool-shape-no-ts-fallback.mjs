import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const directPayload = read('src/server/runtime/http-server/direct-passthrough-payload.ts');
const responsesProvider = read('src/providers/core/runtime/responses-provider.ts');
const serverIndex = read('src/server/runtime/http-server/index.ts');
const routerDirectPipeline = read('src/server/runtime/http-server/router-direct-pipeline.ts');
const nativeExports = read('src/modules/llmswitch/bridge/native-exports.ts');

for (const forbidden of [
  'validateOpenAIResponsesDirectToolPresence',
  'function validateOpenAIResponsesDirectTools',
  'function cloneWirePayload',
  'missing_name',
  'missing_type',
  'Invalid direct Responses function tool at tools[',
  'Invalid direct Responses tool at tools[',
]) {
  if (directPayload.includes(forbidden)) {
    failures.push(`direct payload TS fallback must be removed: ${forbidden}`);
  }
}

for (const forbidden of [
  'validateResponsesDirectToolShapeContractNative',
  'resolveResponsesDirectPayloadNative',
  'applyResponsesDirectRouteParamsOverrideNative',
  'buildResponsesDirectPassthroughBodyNative',
  'hasDeclaredApplyPatchToolNative',
  'evaluateResponsesDirectRouteDecisionNative',
  'evaluateDirectRouteDecision',
  'findResponsesDirectFunctionCallOutputContentViolation',
]) {
  if (directPayload.includes(forbidden)) {
    failures.push(`direct payload must not retain direct body builder/raw replay/runtime preflight path: ${forbidden}`);
  }
}

for (const forbidden of [
  'validateResponsesDirectToolShapeContractNative',
  'assertNativeResponsesDirectContractAvailable',
  'resolveResponsesDirectPayloadNative',
  'applyResponsesDirectRouteParamsOverrideNative',
  'buildResponsesDirectPassthroughBodyNative',
]) {
  if (responsesProvider.includes(forbidden)) {
    failures.push(`responses provider runtime must not call direct body builder/raw replay/runtime validator: ${forbidden}`);
  }
}

for (const forbidden of [
  'stripInternalKeysDeep',
  "missing model from direct passthrough responses payload",
  "metadata is not allowed in direct passthrough responses payload",
]) {
  if (responsesProvider.includes(forbidden)) {
    failures.push(`responses provider must not retain local direct body truth: ${forbidden}`);
  }
}

if (responsesProvider.includes('responses provider received chat-style "messages"')) {
  failures.push('responses provider must not duplicate Rust chat-style messages guard locally');
}

for (const forbidden of [
  'function hasDeclaredApplyPatchTool(',
  'hasDeclaredApplyPatchToolInPayload(',
  'hasDeclaredApplyPatchToolNative',
  "if (type === 'custom' && name.trim() === 'apply_patch')",
]) {
  if (serverIndex.includes(forbidden)) {
    failures.push(`server index must not retain local apply_patch direct eligibility truth: ${forbidden}`);
  }
}

for (const forbidden of [
  'normalizeResponsesInputItemsForProviderWireNative',
  'applyDirectResponsesProviderWireNormalization',
  'captureReqInboundResponsesContextSnapshotJson',
]) {
  if (routerDirectPipeline.includes(forbidden)) {
    failures.push(`router direct must not normalize or clean request payload before provider send: ${forbidden}`);
  }
}

if (nativeExports.includes('normalizeResponsesInputItemsForProviderWireNative')) {
  failures.push('native bridge must not expose a provider-wire Responses input normalizer for direct send');
}
if (nativeExports.includes('evaluateResponsesDirectRouteDecisionNative')) {
  failures.push('native bridge must not expose evaluateResponsesDirectRouteDecisionNative host mirror');
}

if (failures.length > 0) {
  console.error('[verify:responses-direct-tool-shape-no-ts-fallback] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-direct-tool-shape-no-ts-fallback] ok');
console.log('- checked direct/provider entrypoints for Rust-only validation and no residual TS fallback');
