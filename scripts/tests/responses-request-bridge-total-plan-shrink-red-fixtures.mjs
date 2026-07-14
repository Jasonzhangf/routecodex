import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyResponsesRequestBridgeTotalPlanShrink,
} from '../architecture/verify-responses-request-bridge-total-plan-shrink.mjs';

const validFiles = {
  'src/modules/llmswitch/bridge/responses-request-bridge.ts': [
    'import { getSystemPromptOverride } from "../../../utils/system-prompt-loader.js";',
    'const systemPromptOverride = getSystemPromptOverride();',
    'writeMetadataCenterSlot({ target: metadata, family: write.family, key: write.key, value: write.value, writer: write.writer, reason: write.reason });',
    'function planResponsesInboundToolHistoryErrorsampleForHttp(args) { return planResponsesInboundToolHistoryErrorsampleForHttpNative(args); }',
    "if (continuationPlan.action === 'execute_effect') { switch (continuationPlan.effect.operation) {",
    "case 'lookup_continuation': break;",
    "case 'materialize_provider_owned_submit': break;",
    "case 'resume_relay': break;",
    "case 'materialize_scope': break;",
    "} resultPlanInput: continuationPlan.resultPlanInput }",
    'function planResponsesResumeErrorForHttp(error) { return planResponsesResumeErrorForHttpNative(error); }',
  ].join('\n'),
  'src/modules/llmswitch/bridge/native-exports.ts': [
    'type MetadataCenterWrite = { writer: { module: string; symbol: string; stage: string; } };',
    'type NativeBinding = { planResponsesInboundToolHistoryErrorsampleForHttpJson?: (inputJson: string) => string };',
    'type ResumeErrorBinding = { planResponsesResumeErrorForHttpJson?: (inputJson: string) => string };',
    "type ContinuationPlan = { action: 'execute_effect' | 'complete' };",
    "function assertResponsesContinuationRequestActionPlan() { return ['execute_effect', 'complete', 'lookup_continuation', 'materialize_provider_owned_submit', 'resume_relay', 'materialize_scope']; }",
    'metadataCenterWrites: record.metadataCenterWrites.map((entry) => {',
    '  const write = assertNativeObject("write", entry);',
    '  const writer = assertNativeObject("writer", write.writer);',
    '  return { writer: { module: String(writer.module), symbol: String(writer.symbol), stage: String(writer.stage) } };',
    '})',
  ].join('\n'),
  'src/modules/llmswitch/bridge/responses-request-handler-host.ts': [
    'export { planResponsesResumeErrorForHttpNative } from "./native-exports.js";',
  ].join('\n'),
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs': [
    'responses_pipeline_metadata_writer(family)',
    '"MetaReq04RuntimeControlBound"',
    '"MetaReq03ContinuationAttached"',
    'system_prompt_override_json',
    'fn merge_responses_instructions(existing: Option<&str>, override_prompt: &str) -> String { override_prompt.to_string() }',
    'fn plan_responses_inbound_tool_history_errorsample_for_http(input: &Value) -> Value { serde_json::json!({ "action": "write_errorsample" }) }',
    'fn plan_responses_continuation_request_action(input: &Value) -> Value { serde_json::json!({ "action": "execute_effect", "effect": { "operation": "lookup_continuation" }, "resultPlanInput": { "operation": "lookup_continuation" }, "next": ["materialize_provider_owned_submit", "resume_relay", "materialize_scope"], "terminal": "complete" }) }',
    'fn plan_responses_resume_error_for_http(input: &Value) -> Value { serde_json::json!({ "action": "rethrow" }) }',
  ].join('\n'),
  'tests/modules/llmswitch/bridge/responses-request-handler-host-fake.ts': [
    'writer: { module: "m", symbol: "s", stage: "MetaReq04RuntimeControlBound" },',
    'systemPromptOverride',
  ].join('\n'),
  'docs/goals/responses-request-bridge-total-plan-shrink-test-design.md': [
    '# Responses Request Bridge Total Plan Shrink Test Design',
    '## Closed Effect Contract',
  ].join('\n'),
  'package.json': JSON.stringify({
    scripts: {
      'verify:responses-request-bridge-total-plan-shrink': 'node verify.mjs',
      'test:responses-request-bridge-total-plan-shrink-red-fixtures': 'node fixtures.mjs',
    },
  }),
};

function writeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-responses-request-total-plan-'));
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
  const failures = verifyResponsesRequestBridgeTotalPlanShrink(root);
  if (!failures.some((failure) => failure.includes(expectedFragment))) {
    throw new Error(`${name}: expected failure containing ${expectedFragment}; got ${failures.join(' | ')}`);
  }
}

const validRoot = writeFixture();
const validFailures = verifyResponsesRequestBridgeTotalPlanShrink(validRoot);
if (validFailures.length > 0) {
  throw new Error(`valid fixture failed: ${validFailures.join(' | ')}`);
}

expectFailure(
  'local system prompt override',
  {
    'src/modules/llmswitch/bridge/responses-request-bridge.ts': 'applySystemPromptOverride(args.entryEndpoint, payload);\n',
  },
  'applySystemPromptOverride'
);

expectFailure(
  'local writer branch',
  {
    'src/modules/llmswitch/bridge/responses-request-bridge.ts': "writer: write.family === 'continuation_context' ? a : b,\n",
  },
  "write.family === 'continuation_context'"
);

expectFailure(
  'native wrapper missing writer',
  {
    'src/modules/llmswitch/bridge/native-exports.ts': 'metadataCenterWrites: record.metadataCenterWrites.map((entry) => entry)\n',
  },
  'writer descriptor'
);

expectFailure(
  'rust owner missing prompt plan',
  {
    'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs': [
      'responses_pipeline_metadata_writer(family)',
      '"MetaReq04RuntimeControlBound"',
      '"MetaReq03ContinuationAttached"',
    ].join('\n'),
  },
  'system_prompt_override_json'
);

expectFailure(
  'local tool history classification',
  {
    'src/modules/llmswitch/bridge/responses-request-bridge.ts': "if (code !== 'MALFORMED_REQUEST') return; if (message.includes('Tool history contract violated')) await writeErrorsampleJson({});\n",
  },
  'MALFORMED_REQUEST'
);

expectFailure(
  'local continuation lookup id',
  {
    'src/modules/llmswitch/bridge/responses-request-bridge.ts': 'const continuationLookupId = isSubmitToolOutputs ? responseId : previousResponseId;\n',
  },
  'continuationLookupId'
);

for (const [name, residue, expected] of [
  ['local continuation lookup parser', 'function readResponsesContinuationLookupForHttp() {}', 'readResponsesContinuationLookupForHttp'],
  ['local direct-submit branch', "case 'direct_submit': break;", "case 'direct_submit'"],
  ['local relay-submit branch', "case 'relay_submit': break;", "case 'relay_submit'"],
  ['local continuation owner classification', "if (continuationAction.continuationOwner === 'relay') {}", "continuationAction.continuationOwner === 'relay'"],
  ['local response-id default', "const id = typeof continuationAction.responseId === 'string' ? continuationAction.responseId : responseId;", "typeof continuationAction.responseId === 'string'"],
  ['local payload mutation', 'payload.previous_response_id = plannedResponseId;', 'payload.previous_response_id = plannedResponseId'],
  ['local endpoint default', "const endpoint = typeof continuationAction.pipelineEntryEndpoint === 'string' ? continuationAction.pipelineEntryEndpoint : entryEndpoint;", "typeof continuationAction.pipelineEntryEndpoint === 'string'"],
  ['local materialized input merge', 'if (materialized?.payload.input) payload.input = materialized.payload.input;', 'materialized?.payload.input'],
]) {
  expectFailure(
    name,
    {
      'src/modules/llmswitch/bridge/responses-request-bridge.ts': residue,
    },
    expected
  );
}

expectFailure(
  'split resume error helper',
  {
    'src/modules/llmswitch/bridge/native-exports.ts': 'export function buildResponsesResumeClientErrorForHttpNative() {}\\n',
  },
  'retired split resume-error helper'
);

expectFailure(
  'local resume error defaults',
  {
    'src/modules/llmswitch/bridge/responses-request-bridge.ts': "const code = 'responses_resume_failed'; const message = 'Unable to resume Responses conversation';\n",
  },
  'responses_resume_failed'
);

console.log('[test:responses-request-bridge-total-plan-shrink-red-fixtures] ok');
console.log('- valid contract accepted; system-prompt, writer branch, missing writer, missing Rust prompt plan, local tool-history classification, local continuation lookup, and local resume-error defaults rejected');
