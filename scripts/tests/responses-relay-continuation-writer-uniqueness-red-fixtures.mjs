import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyResponsesRelayContinuationWriterUniqueness,
} from '../architecture/verify-responses-relay-continuation-writer-uniqueness.mjs';

const validFiles = {
  'src/server/handlers/responses-handler.ts': 'sendPipelineResponse(result);\n',
  'src/modules/llmswitch/bridge/responses-request-bridge.ts': 'export function prepareResponsesHandlerRuntimeForHttp() {}\n',
  'src/modules/llmswitch/bridge/provider-response-effects.ts': [
    'publishResponsesRecordPlanWithNative({ requestId });',
    'executeResponsesContinuationStoreEffects(plan.continuationStoreEffects);',
  ].join('\n'),
  'src/modules/llmswitch/bridge/responses-conversation-store-host.ts': [
    'for (const effect of effects) {',
    '  executeStoreOperation<unknown>(effect.operation, effect.payload);',
    '}',
  ].join('\n'),
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs': [
    '"operation": "record_response",',
    '"operation": "finalize_retention",',
    '"continuationStoreEffects": continuation_store_effects,',
  ].join('\n'),
  'docs/architecture/function-map.yml': [
    '  - feature_id: server.responses_request_handler_bridge_surface',
    '    canonical_builders: [prepareResponsesHandlerRuntimeForHttp]',
    '  - feature_id: hub.chat_process_responses_continuation',
    '    notes:',
    '      - Handler/SSE/resp_outbound must not persist or rebuild canonical continuation truth',
  ].join('\n'),
  'docs/architecture/verification-map.yml': [
    '  - feature_id: server.responses_request_handler_bridge_surface',
    '    smoke: [npm run verify:responses-relay-continuation-writer-uniqueness]',
    '  - feature_id: hub.chat_process_responses_continuation',
    '    smoke: [npm run verify:responses-relay-continuation-writer-uniqueness]',
  ].join('\n'),
  'docs/architecture/resource-operation-map.yml': [
    '  - resource_id: continuation.scope_state',
    '    allowed_writers: [ChatProcReqContinuation02OwnerResolved, ChatProcRespContinuation07CanonicalSaved]',
    '    forbidden_writers: [HubRespOutbound04ClientSemantic, ServerRespOutbound05ClientFrame, sse.transport_frame]',
  ].join('\n'),
  'docs/architecture/mainline-call-map.yml': [
    '  - step_id: rct-06',
    '    callee_symbol: recordResponsesResponse',
    '    note: SSE/handler closeout must not revive save logic',
  ].join('\n'),
  'package.json': JSON.stringify({
    scripts: {
      'verify:responses-relay-continuation-writer-uniqueness': 'node verify.mjs',
      'test:responses-relay-continuation-writer-uniqueness-red-fixtures': 'node fixtures.mjs',
    },
  }),
};

function writeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-relay-writer-gate-'));
  const files = { ...validFiles, ...overrides };
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source);
  }
  return root;
}

function expectFailure(name, overrides, expectedFragment) {
  const root = writeFixture(overrides);
  const failures = verifyResponsesRelayContinuationWriterUniqueness(root);
  if (!failures.some((failure) => failure.includes(expectedFragment))) {
    throw new Error(`${name}: expected failure containing ${expectedFragment}; got ${failures.join(' | ')}`);
  }
}

const validRoot = writeFixture();
const validFailures = verifyResponsesRelayContinuationWriterUniqueness(validRoot);
if (validFailures.length > 0) {
  throw new Error(`valid fixture failed: ${validFailures.join(' | ')}`);
}

expectFailure(
  'handler post-pipeline save',
  {
    'src/server/handlers/responses-handler.ts': 'await finalizeResponsesPipelineResultForHttp(result);\n',
  },
  'handler must not own post-pipeline relay save token'
);

expectFailure(
  'request bridge response-side seed',
  {
    'src/modules/llmswitch/bridge/responses-request-bridge.ts': 'function seedResponsesToolCallResponseForHttp() {}\n',
  },
  'request bridge must not own response-side relay save token'
);

expectFailure(
  'missing Rust canonical writer',
  {
    'src/modules/llmswitch/bridge/provider-response-effects.ts': 'publishResponsesRecordPlanWithNative({ requestId });\n',
  },
  'continuationStoreEffects must pass unchanged'
);

expectFailure(
  'missing Rust effect order',
  {
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs': [
      '"operation": "finalize_retention",',
      '"continuationStoreEffects": continuation_store_effects,',
    ].join('\n'),
  },
  'missing closed ordered Rust store effect contract "operation": "record_response"'
);

console.log('[test:responses-relay-continuation-writer-uniqueness-red-fixtures] ok');
console.log('- valid contract accepted; handler save, bridge seed, missing Rust canonical writer, and missing Rust effect order rejected');
