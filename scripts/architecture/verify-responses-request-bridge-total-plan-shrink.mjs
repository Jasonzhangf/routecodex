import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredFiles = {
  requestBridge: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  nativeExports: 'src/modules/llmswitch/bridge/native-exports.ts',
  handlerHost: 'src/modules/llmswitch/bridge/responses-request-handler-host.ts',
  rustOwner: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
  hostFake: 'tests/modules/llmswitch/bridge/responses-request-handler-host-fake.ts',
  testDesign: 'docs/goals/responses-request-bridge-total-plan-shrink-test-design.md',
  packageJson: 'package.json',
};

function readRequired(root, relativePath, failures) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: required source is missing`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireText(source, expected, message, failures) {
  if (!source.includes(expected)) failures.push(message);
}

function forbidText(source, forbidden, message, failures) {
  if (source.includes(forbidden)) failures.push(message);
}

export function verifyResponsesRequestBridgeTotalPlanShrink(root) {
  const failures = [];
  const sources = Object.fromEntries(
    Object.entries(requiredFiles).map(([key, relativePath]) => [key, readRequired(root, relativePath, failures)])
  );

  for (const token of [
    "applySystemPromptOverride",
    "RESPONSES_PIPELINE_METADATA_WRITER",
    "RESPONSES_PIPELINE_CONTINUATION_WRITER",
    "write.family === 'continuation_context'",
    "write.family !== 'runtime_control'",
    "Unsupported responses pipeline metadata write family",
    "code !== 'MALFORMED_REQUEST'",
    "Tool history contract violated",
    "toolHistoryContractViolation",
    "continuationLookupId",
    "isSubmitToolOutputs ? responseId",
    "buildResponsesResumeClientErrorForHttp",
    "shouldProjectResponsesResumeClientErrorForHttp",
    "responses_resume_failed",
    "Unable to resume Responses conversation",
    "function readResponsesContinuationLookupForHttp",
    "case 'direct_submit'",
    "case 'relay_submit'",
    "case 'relay_scope_materialize'",
    "case 'attach_resume_meta'",
    "continuationAction.materializeProviderOwnedSubmitContext === true",
    "continuationAction.continuationOwner === 'relay'",
    "typeof continuationAction.responseId === 'string'",
    "payload.previous_response_id = plannedResponseId",
    "typeof continuationAction.pipelineEntryEndpoint === 'string'",
    "continuationAction.resumeMeta && typeof",
    "materialized?.payload.input",
    "resumeResult.payload ?? {}",
    "response_id is required for submit_tool_outputs",
  ]) {
    forbidText(
      sources.requestBridge,
      token,
      `${requiredFiles.requestBridge}: TS request bridge must not retain semantic residue token ${token}`,
      failures
    );
  }

  requireText(
    sources.requestBridge,
    'writer: write.writer,',
    `${requiredFiles.requestBridge}: MetadataCenter slot writer must come from the Rust plan`,
    failures
  );
  requireText(
    sources.requestBridge,
    'getSystemPromptOverride()',
    `${requiredFiles.requestBridge}: TS may only read host prompt override IO before passing it to Rust`,
    failures
  );
  requireText(
    sources.requestBridge,
    'systemPromptOverride',
    `${requiredFiles.requestBridge}: finalized payload call must pass host-read prompt override into Rust`,
    failures
  );
  requireText(
    sources.requestBridge,
    'function planResponsesInboundToolHistoryErrorsampleForHttp(',
    `${requiredFiles.requestBridge}: inbound tool-history errorsample classification must come from the Rust plan`,
    failures
  );
  requireText(
    sources.requestBridge,
    "continuationPlan.action === 'execute_effect'",
    `${requiredFiles.requestBridge}: continuation IO execution must consume the closed Rust effect plan`,
    failures
  );
  for (const required of [
    "case 'lookup_continuation':",
    "case 'materialize_provider_owned_submit':",
    "case 'resume_relay':",
    "case 'materialize_scope':",
    'resultPlanInput: continuationPlan.resultPlanInput',
  ]) {
    requireText(
      sources.requestBridge,
      required,
      `${requiredFiles.requestBridge}: continuation effect loop missing closed-plan fragment ${required}`,
      failures
    );
  }
  requireText(
    sources.requestBridge,
    'function planResponsesResumeErrorForHttp(',
    `${requiredFiles.requestBridge}: resume-error projection and descriptor must come from one Rust total plan`,
    failures
  );

  for (const required of [
    'writer: {',
    'stage: string;',
    'metadataCenterWrites: record.metadataCenterWrites.map',
    'assertNativeObject(',
    'planResponsesInboundToolHistoryErrorsampleForHttpJson',
    'planResponsesResumeErrorForHttpJson',
    'assertResponsesContinuationRequestActionPlan',
    "'execute_effect'",
    "'complete'",
    "'materialize_provider_owned_submit'",
    "'resume_relay'",
    "'materialize_scope'",
  ]) {
    requireText(
      sources.nativeExports,
      required,
      `${requiredFiles.nativeExports}: native wrapper must validate and expose Rust metadata write writer descriptor (${required})`,
      failures
    );
  }

  for (const required of [
    'responses_pipeline_metadata_writer(family)',
    '"MetaReq04RuntimeControlBound"',
    '"MetaReq03ContinuationAttached"',
    'system_prompt_override_json',
    'merge_responses_instructions',
    'plan_responses_inbound_tool_history_errorsample_for_http',
    '"write_errorsample"',
    '"lookup_continuation"',
    '"execute_effect"',
    '"resultPlanInput"',
    '"materialize_provider_owned_submit"',
    '"resume_relay"',
    '"materialize_scope"',
    '"complete"',
    'plan_responses_resume_error_for_http',
    '"rethrow"',
  ]) {
    requireText(
      sources.rustOwner,
      required,
      `${requiredFiles.rustOwner}: Rust owner missing total-plan contract fragment ${required}`,
      failures
    );
  }

  requireText(
    sources.hostFake,
    'writer: {',
    `${requiredFiles.hostFake}: owner-specific fake must mirror Rust writer descriptor shape`,
    failures
  );
  requireText(
    sources.handlerHost,
    'planResponsesResumeErrorForHttpNative',
    `${requiredFiles.handlerHost}: narrow request handler host must export the Rust resume-error total plan`,
    failures
  );

  for (const [sourceName, source] of [
    ['nativeExports', sources.nativeExports],
    ['handlerHost', sources.handlerHost],
    ['rustOwner', sources.rustOwner],
  ]) {
    for (const forbidden of [
      'buildResponsesResumeClientErrorForHttpJson',
      'shouldProjectResponsesResumeClientErrorForHttpJson',
      'buildResponsesResumeClientErrorForHttpNative',
      'shouldProjectResponsesResumeClientErrorForHttpNative',
      'build_responses_resume_client_error_for_http_json',
      'should_project_responses_resume_client_error_for_http_json',
    ]) {
      forbidText(
        source,
        forbidden,
        `${requiredFiles[sourceName]}: retired split resume-error helper must stay deleted (${forbidden})`,
        failures
      );
    }
  }
  requireText(
    sources.hostFake,
    'systemPromptOverride',
    `${requiredFiles.hostFake}: owner-specific fake must mirror Rust finalize prompt input`,
    failures
  );

  requireText(
    sources.testDesign,
    'Responses Request Bridge Total Plan Shrink Test Design',
    `${requiredFiles.testDesign}: missing test design`,
    failures
  );
  requireText(
    sources.testDesign,
    'Closed Effect Contract',
    `${requiredFiles.testDesign}: missing closed continuation effect contract`,
    failures
  );
  requireText(
    sources.packageJson,
    '"verify:responses-request-bridge-total-plan-shrink"',
    `${requiredFiles.packageJson}: missing total-plan shrink verify script`,
    failures
  );
  requireText(
    sources.packageJson,
    '"test:responses-request-bridge-total-plan-shrink-red-fixtures"',
    `${requiredFiles.packageJson}: missing total-plan shrink red-fixture script`,
    failures
  );

  return failures;
}

function runCli() {
  const root = process.env.ROUTECODEX_VERIFY_ROOT || process.cwd();
  const failures = verifyResponsesRequestBridgeTotalPlanShrink(root);
  if (failures.length > 0) {
    console.error('[verify:responses-request-bridge-total-plan-shrink] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[verify:responses-request-bridge-total-plan-shrink] ok');
  console.log('- responses request bridge metadata writers, prompt finalization, tool-history errorsample classification, closed continuation effects/results, and resume error projection are Rust-planned host IO');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
