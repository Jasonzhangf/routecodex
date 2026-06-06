import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const responsesProvider = read('src/providers/core/runtime/responses-provider.ts');
const directContractError = read('src/providers/core/runtime/responses-direct-contract-error.ts');
const directPayload = read('src/server/runtime/http-server/direct-passthrough-payload.ts');
const rustValidator = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');
const ciJest = read('scripts/tests/ci-jest.mjs');
const directSpec = read('tests/server/runtime/http-server/direct-passthrough-payload.spec.ts');
const providerSpec = read('tests/providers/core/runtime/protocol-http-providers.unit.test.ts');
const routeLevelSpec = read('tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts');
const serverIndex = read('src/server/runtime/http-server/index.ts');
const directPayloadModule = read('src/server/runtime/http-server/direct-passthrough-payload.ts');

for (const expected of [
  'responses payload tools[',
  'chat-style function tool',
  'Responses wire requires top-level tool.name',
]) {
  if (!rustValidator.includes(expected)) {
    failures.push(`rust validator missing contract text: ${expected}`);
  }
}

for (const expected of [
  'evaluateDirectRouteDecision',
  'evaluateResponsesDirectRouteDecisionNative',
]) {
  if (!directPayload.includes(expected)) {
    failures.push(`direct payload contract missing invariant: ${expected}`);
  }
}

if (
  !responsesProvider.includes('assertNativeResponsesDirectContractAvailable')
  || !directContractError.includes('native responses direct tool-shape validator unavailable')
) {
  failures.push('responses-provider must fail fast through shared native-unavailable projector');
}

if (!ciJest.includes('tests/server/runtime/http-server/direct-passthrough-payload.spec.ts')) {
  failures.push('ci-jest must include tests/server/runtime/http-server/direct-passthrough-payload.spec.ts');
}
if (!ciJest.includes('tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts')) {
  failures.push('ci-jest must include tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts');
}

if (!directSpec.includes('rejects historical chat-style function tools on responses direct')) {
  failures.push('direct passthrough spec missing chat-style function tool regression');
}

if (!directSpec.includes('Responses wire requires top-level tool.name')) {
  failures.push('direct passthrough spec must assert Rust-native tool.name contract text');
}

if (!providerSpec.includes('rejects chat-style response tools before transport')) {
  failures.push('responses provider unit spec missing pre-transport chat-style function tool regression');
}

for (const expected of [
  'router same-protocol direct still skips legacy apply_patch servertool metadata when tool shape is chat-style invalid',
  'router same-protocol direct validates Responses custom apply_patch instead of forcing servertool relay',
]) {
  if (!routeLevelSpec.includes(expected)) {
    failures.push(`route-level direct relay spec missing regression: ${expected}`);
  }
}

for (const expected of [
  'evaluateDirectRouteDecision',
]) {
  if (!serverIndex.includes(expected) && !directPayloadModule.includes(expected)) {
    failures.push(`router direct relay guard missing anchor: ${expected}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-direct-tool-shape-contract] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-direct-tool-shape-contract] ok');
console.log('- checked provider runtime, direct payload contract, CI jest wiring, and regressions');
