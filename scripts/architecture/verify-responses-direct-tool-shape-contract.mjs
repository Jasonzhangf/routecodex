import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function readIfExists(relPath) {
  const absPath = path.join(root, relPath);
  return fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;
}

const responsesProvider = read('src/providers/core/runtime/responses-provider.ts');
const directPayload = read('src/server/runtime/http-server/direct-passthrough-payload.ts');
const rustValidator = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');
const ciJest = read('scripts/tests/ci-jest.mjs');
const directSpec = readIfExists('tests/server/runtime/http-server/direct-passthrough-payload.spec.ts');
const providerSpec = readIfExists('tests/providers/core/runtime/protocol-http-providers.unit.test.ts');
const serverIndex = read('src/server/runtime/http-server/index.ts');
const pkg = read('package.json');

if (!directPayload.includes('requireDirectPassthroughPayloadObject')) {
  failures.push('direct payload contract missing invariant: requireDirectPassthroughPayloadObject');
}
for (const forbidden of [
  'findResponsesDirectFunctionCallOutputContentViolation',
  'evaluateDirectRouteDecision',
  'evaluateResponsesDirectRouteDecisionNative',
]) {
  if (directPayload.includes(forbidden)) {
    failures.push(`direct payload helper must not run provider-wire preflight: ${forbidden}`);
  }
}
for (const forbidden of [
  'findResponsesDirectFunctionCallOutputContentViolation',
  'buildDirectPayloadContractError',
  'annotateAsHostPayloadContractError',
]) {
  if (serverIndex.includes(forbidden)) {
    failures.push(`router direct must not preflight Responses provider wire shape: ${forbidden}`);
  }
}
for (const forbidden of [
  'client_tools_require_hub_relay',
  'stopless_servertool_requires_hub_relay',
  'responses_chat_process_requires_hub_relay',
  'servertool_followup_requires_hub_relay',
]) {
  if (serverIndex.includes(forbidden)) {
    failures.push(`router direct must not turn Responses tool/chat-process semantics into Hub relay: ${forbidden}`);
  }
}

if (responsesProvider.includes('assertNativeResponsesDirectContractAvailable')) {
  failures.push('responses-provider must not runtime-call direct protocol validator projector');
}

if (!ciJest.includes('tests/server/runtime/http-server/direct-passthrough-payload.spec.ts')) {
  failures.push('ci-jest must include tests/server/runtime/http-server/direct-passthrough-payload.spec.ts');
}
if (!ciJest.includes('tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts')) {
  failures.push('ci-jest must include tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts');
}

if (directSpec && !directSpec.includes('allows chat-style function tools on responses same-protocol direct')) {
  failures.push('direct passthrough spec must assert same-protocol chat-style client tools stay on direct');
}

if (directSpec && !directSpec.includes('keeps historical responses tool input content on direct without wire-shape preflight')) {
  failures.push('direct passthrough spec must assert historical tool content is not preflighted on direct');
}

if (directSpec && directSpec.includes('evaluateResponsesDirectRouteDecisionJson JSON stringify failed')) {
  failures.push('direct passthrough spec must not lock native stringify failure as expected behavior');
}

if (providerSpec && !providerSpec.includes('direct passthrough sends chat-style response tools to transport')) {
  failures.push('responses provider unit spec must assert direct sends chat-style tools to transport');
}

for (const forbidden of [
  'responses tools require Hub relay tool governance',
  'valid_responses_tools_require_hub_relay',
  'has_declared_responses_tools',
  'validateResponsesDirectToolShapeContractNative(finalBody)',
  'buildResponsesDirectPassthroughBodyNative',
  'resolveResponsesDirectPayloadNative',
  'applyResponsesDirectRouteParamsOverrideNative',
  '__raw_request_body',
]) {
  if (
    rustValidator.includes(forbidden)
    || directPayload.includes(forbidden)
    || responsesProvider.includes(forbidden)
  ) {
    failures.push(`direct runtime must not revive relay-by-tool-shape rule: ${forbidden}`);
  }
}

if (directSpec && !directSpec.includes('expect(resolved).toBe(body)')) {
  failures.push('direct passthrough spec must assert resolver returns original body object');
}

if (directSpec && !directSpec.includes('expect(result).toBe(body)')) {
  failures.push('direct passthrough spec must assert minimal override mutates original body object');
}

const directMinimumOverrideSpec = readIfExists('tests/server/runtime/http-server/direct-passthrough-minimum-overrides.spec.ts');
if (directMinimumOverrideSpec && !directMinimumOverrideSpec.includes('expect((output.input as unknown[])[0]).toBe(firstHistoryItem)')) {
  failures.push('direct minimum override spec must assert direct route overrides do not rewrite history items');
}

if (!pkg.includes('verify:responses-function-tool-normalization-rust-only')) {
  failures.push('package build gate must include compile-time responses function-tool normalization verification');
}

if (failures.length > 0) {
  console.error('[verify:responses-direct-tool-shape-contract] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-direct-tool-shape-contract] ok');
console.log('- checked provider runtime, same-protocol direct contract, CI jest wiring, and regressions');
