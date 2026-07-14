import fs from 'node:fs';
import path from 'node:path';

const requiredFiles = {
  requestBridge: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  runtimeIntegrations: 'src/modules/llmswitch/bridge/runtime-integrations.ts',
  storeHost: 'src/modules/llmswitch/bridge/responses-conversation-store-host.ts',
  responseEffects: 'src/modules/llmswitch/bridge/provider-response-effects.ts',
  handler: 'src/server/handlers/responses-handler.ts',
  rustStore: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
  rustReqInbound: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs',
  verificationMap: 'docs/architecture/verification-map.yml',
};

function readRequired(root, relativePath, failures) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(relativePath + ': required source is missing');
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
  const marker = '- feature_id: ' + featureId;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const nextMarker = String.fromCharCode(10) + '  - feature_id:';
  const next = source.indexOf(nextMarker, start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const brace = source.indexOf('{', start);
  if (brace === -1) return '';
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

function sourceBeforeRustTests(source) {
  const marker = '#[cfg(test)]';
  const index = source.indexOf(marker);
  return index === -1 ? source : source.slice(0, index);
}

function exportedFunctionBlock(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const next = source.indexOf(String.fromCharCode(10) + 'export ', start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function verifyPassThroughFunction(source, signature, requiredCall, forbiddenTokens, fileLabel, failures) {
  const body = exportedFunctionBlock(source, signature);
  if (!body) {
    failures.push(fileLabel + ': missing ' + signature);
    return;
  }
  requireText(body, requiredCall, fileLabel + ': ' + signature + ' must remain a narrow pass-through', failures);
  for (const token of forbiddenTokens) {
    forbidText(body, token, fileLabel + ': ' + signature + ' must not perform continuation/history logic: ' + token, failures);
  }
}

export function verifyResponsesContinuationImmutableBoundary(root) {
  const failures = [];
  const sources = Object.fromEntries(
    Object.entries(requiredFiles).map(([key, relativePath]) => [key, readRequired(root, relativePath, failures)])
  );

  const productionRustStore = sourceBeforeRustTests(sources.rustStore);
  const productionRustReqInbound = sourceBeforeRustTests(sources.rustReqInbound);

  for (const [key, source] of Object.entries({
    requestBridge: sources.requestBridge,
    runtimeIntegrations: sources.runtimeIntegrations,
    storeHost: sources.storeHost,
    responseEffects: sources.responseEffects,
    handler: sources.handler,
    rustStore: productionRustStore,
    rustReqInbound: productionRustReqInbound,
  })) {
    for (const forbidden of ['entryOriginRequest', 'capturedChatRequest', 'requestSemantics']) {
      forbidText(
        source,
        forbidden,
        requiredFiles[key] + ': immutable save->restore interval must not use ' + forbidden + ' to rebuild history/context',
        failures
      );
    }
  }

  verifyPassThroughFunction(
    sources.runtimeIntegrations,
    'export async function recordResponsesResponseForRequest',
    'recordResponsesResponse(args);',
    ['input:', 'tool_outputs', 'previous_response_id', 'entryOriginRequest', 'capturedChatRequest', 'requestSemantics'],
    requiredFiles.runtimeIntegrations,
    failures
  );
  verifyPassThroughFunction(
    sources.runtimeIntegrations,
    'export async function resumeResponsesConversation',
    'return resumeResponsesConversationHost(responseId, submitPayload, options);',
    ['input:', 'tool_outputs', 'previous_response_id', 'entryOriginRequest', 'capturedChatRequest', 'requestSemantics'],
    requiredFiles.runtimeIntegrations,
    failures
  );

  requireText(
    sources.responseEffects,
    'executeResponsesContinuationStoreEffects(plan.continuationStoreEffects);',
    requiredFiles.responseEffects + ': response save must execute Rust-planned store effects unchanged',
    failures
  );
  requireText(
    sources.storeHost,
    'executeStoreOperation<unknown>(effect.operation, effect.payload);',
    requiredFiles.storeHost + ': store host must pass Rust operation/payload unchanged',
    failures
  );

  const releaseBody = functionBody(productionRustStore, 'fn plan_responses_release_request_payload');
  if (!releaseBody) {
    failures.push(requiredFiles.rustStore + ': missing plan_responses_release_request_payload');
  } else {
    for (const required of [
      'strip_responses_stored_context_input_media',
      'collect_responses_pending_tool_call_ids',
      '"releasedInputPrefix"',
      '"releasedPendingToolCallIds"',
      '"input": []',
    ]) {
      requireText(
        releaseBody,
        required,
        requiredFiles.rustStore + ': release plan must retain only semantic shrink/normalization contract ' + required,
        failures
      );
    }
    for (const forbidden of [
      'convert_responses_output_to_input_items',
      'normalize_responses_input_items',
      'capture_req_inbound_responses_context_snapshot',
      'plan_responses_request_context',
      'plan_responses_continuation_request_action',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
    ]) {
      forbidText(
        releaseBody,
        forbidden,
        requiredFiles.rustStore + ': release plan must not rebuild/repair tool history in immutable interval: ' + forbidden,
        failures
      );
    }
  }

  const continuationFeature = featureSection(sources.verificationMap, 'hub.chat_process_responses_continuation');
  requireText(
    continuationFeature,
    'npm run verify:responses-continuation-immutable-boundary',
    requiredFiles.verificationMap + ': continuation feature must require immutable boundary gate',
    failures
  );
  requireText(
    continuationFeature,
    'save->restore interval is immutable',
    requiredFiles.verificationMap + ': continuation feature must document immutable interval evidence',
    failures
  );

  return failures;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const failures = verifyResponsesContinuationImmutableBoundary(process.cwd());
  if (failures.length) {
    console.error('Responses continuation immutable boundary verification failed:');
    for (const failure of failures) console.error('- ' + failure);
    process.exit(1);
  }
  console.log('Responses continuation immutable boundary verification passed.');
}
