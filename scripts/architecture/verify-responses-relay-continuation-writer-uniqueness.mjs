import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredFiles = {
  handler: 'src/server/handlers/responses-handler.ts',
  requestBridge: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  responseEffects: 'src/modules/llmswitch/bridge/provider-response-effects.ts',
  storeHost: 'src/modules/llmswitch/bridge/responses-conversation-store-host.ts',
  rustOwner: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
  functionMap: 'docs/architecture/function-map.yml',
  verificationMap: 'docs/architecture/verification-map.yml',
  resourceMap: 'docs/architecture/resource-operation-map.yml',
  mainlineMap: 'docs/architecture/mainline-call-map.yml',
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

function featureSection(source, featureId) {
  const marker = `- feature_id: ${featureId}`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const next = source.indexOf('\n  - feature_id:', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

export function verifyResponsesRelayContinuationWriterUniqueness(root) {
  const failures = [];
  const sources = Object.fromEntries(
    Object.entries(requiredFiles).map(([key, relativePath]) => [key, readRequired(root, relativePath, failures)])
  );

  requireText(
    sources.responseEffects,
    'executeResponsesContinuationStoreEffects(plan.continuationStoreEffects);',
    `${requiredFiles.responseEffects}: ordered Rust continuationStoreEffects must pass unchanged to conversation-store IO`,
    failures
  );
  requireText(
    sources.responseEffects,
    'publishResponsesRecordPlanWithNative({',
    `${requiredFiles.responseEffects}: missing Rust canonical record-plan call`,
    failures
  );
  for (const forbidden of ['plan.recordArgs', 'plan.finalizeArgs']) {
    forbidText(
      sources.responseEffects,
      forbidden,
      `${requiredFiles.responseEffects}: legacy TS continuation effect orchestration remains: ${forbidden}`,
      failures
    );
  }
  requireText(
    sources.storeHost,
    'for (const effect of effects)',
    `${requiredFiles.storeHost}: store host must preserve Rust effect order`,
    failures
  );
  requireText(
    sources.storeHost,
    'executeStoreOperation<unknown>(effect.operation, effect.payload);',
    `${requiredFiles.storeHost}: store host must pass Rust operation/payload unchanged`,
    failures
  );
  for (const required of [
    '"continuationStoreEffects": continuation_store_effects',
    '"operation": "record_response"',
    '"operation": "finalize_retention"',
  ]) {
    requireText(
      sources.rustOwner,
      required,
      `${requiredFiles.rustOwner}: missing closed ordered Rust store effect contract ${required}`,
      failures
    );
  }
  for (const stale of ['"recordArgs": record_args', '"finalizeArgs": finalize_args']) {
    forbidText(
      sources.rustOwner,
      stale,
      `${requiredFiles.rustOwner}: legacy split continuation effect field remains ${stale}`,
      failures
    );
  }

  for (const token of [
    'finalizeResponsesPipelineResultForHttp',
    'recordResponsesResponseForRequest',
    'recordResponsesResponse(',
  ]) {
    forbidText(
      sources.handler,
      token,
      `${requiredFiles.handler}: handler must not own post-pipeline relay save token ${token}`,
      failures
    );
  }

  for (const token of [
    'finalizeResponsesPipelineResultForHttp',
    'seedResponsesToolCallResponseForHttp',
    'recordResponsesResponseForHttp',
    'recordResponsesResponseForRequest',
    "from '../../../server/utils/finish-reason.js'",
  ]) {
    forbidText(
      sources.requestBridge,
      token,
      `${requiredFiles.requestBridge}: request bridge must not own response-side relay save token ${token}`,
      failures
    );
  }

  const continuationFeature = featureSection(sources.functionMap, 'hub.chat_process_responses_continuation');
  const requestBridgeFeature = featureSection(sources.functionMap, 'server.responses_request_handler_bridge_surface');
  requireText(
    continuationFeature,
    'Handler/SSE/resp_outbound must not persist or rebuild canonical continuation truth',
    `${requiredFiles.functionMap}: continuation feature must state the handler/SSE/resp_outbound writer ban`,
    failures
  );
  for (const staleBuilder of [
    'finalizeResponsesPipelineResultForHttp',
    'seedResponsesToolCallResponseForHttp',
    'recordResponsesResponseForHttp',
  ]) {
    forbidText(
      requestBridgeFeature,
      staleBuilder,
      `${requiredFiles.functionMap}: request bridge feature still lists deleted builder ${staleBuilder}`,
      failures
    );
  }

  const continuationVerification = featureSection(
    sources.verificationMap,
    'hub.chat_process_responses_continuation'
  );
  const requestBridgeVerification = featureSection(
    sources.verificationMap,
    'server.responses_request_handler_bridge_surface'
  );
  for (const section of [continuationVerification, requestBridgeVerification]) {
    requireText(
      section,
      'npm run verify:responses-relay-continuation-writer-uniqueness',
      `${requiredFiles.verificationMap}: affected feature must require the relay writer uniqueness gate`,
      failures
    );
  }

  requireText(
    sources.resourceMap,
    'allowed_writers: [ChatProcReqContinuation02OwnerResolved, ChatProcRespContinuation07CanonicalSaved]',
    `${requiredFiles.resourceMap}: continuation.scope_state allowed writers drifted`,
    failures
  );
  requireText(
    sources.resourceMap,
    'forbidden_writers: [HubRespOutbound04ClientSemantic, ServerRespOutbound05ClientFrame, sse.transport_frame]',
    `${requiredFiles.resourceMap}: continuation.scope_state must forbid outbound/handler/SSE writers`,
    failures
  );

  requireText(
    sources.mainlineMap,
    'callee_symbol: recordResponsesResponse',
    `${requiredFiles.mainlineMap}: rct-06 canonical store edge is missing`,
    failures
  );
  requireText(
    sources.mainlineMap,
    'SSE/handler closeout must not revive save logic',
    `${requiredFiles.mainlineMap}: rct-06 must forbid handler/SSE save revival`,
    failures
  );

  requireText(
    sources.packageJson,
    '"verify:responses-relay-continuation-writer-uniqueness"',
    `${requiredFiles.packageJson}: missing relay writer uniqueness verify script`,
    failures
  );
  requireText(
    sources.packageJson,
    '"test:responses-relay-continuation-writer-uniqueness-red-fixtures"',
    `${requiredFiles.packageJson}: missing relay writer uniqueness red-fixture script`,
    failures
  );

  return failures;
}

function runCli() {
  const root = process.env.ROUTECODEX_VERIFY_ROOT || process.cwd();
  const failures = verifyResponsesRelayContinuationWriterUniqueness(root);
  if (failures.length > 0) {
    console.error('[verify:responses-relay-continuation-writer-uniqueness] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[verify:responses-relay-continuation-writer-uniqueness] ok');
  console.log('- relay canonical save has one Rust plan owner; handler/request bridge cannot revive response-side save');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
