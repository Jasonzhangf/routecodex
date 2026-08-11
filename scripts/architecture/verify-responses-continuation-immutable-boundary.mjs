import fs from 'node:fs';
import path from 'node:path';

const requiredFiles = {
  reqInbound: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  reqRestore: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  respCommit: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  respOutbound: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
  serverFrame: 'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
  responsesRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  serverLib: 'v3/crates/routecodex-v3-server/src/lib.rs',
  endpointHandlers: 'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
  websocket: 'v3/crates/routecodex-v3-server/src/websocket.rs',
  executors: 'v3/crates/routecodex-v3-server/src/executors.rs',
  frameBuilders: 'v3/crates/routecodex-v3-server/src/frame_builders.rs',
  liveSnapshot: 'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
  localContinuation: 'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
  directKernel: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  directState: 'v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
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

function requireNonEmpty(source, owner, failures) {
  if (!source || source.trim().length === 0) {
    failures.push(owner + ': immutable-interval owner body is missing');
  }
}

function forbidText(source, forbidden, message, failures) {
  if (source.includes(forbidden)) failures.push(message);
}

function featureSection(source, featureId) {
  const marker = '- feature_id: ' + featureId;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const nextMarker = String.fromCharCode(10) + '- feature_id:';
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

function allFunctionBodiesMatching(source, signaturePattern, ownerLabel) {
  const bodies = [];
  const matches = source.matchAll(signaturePattern);
  for (const match of matches) {
    const signature = match[0].replace(/^[\r\n]+/, '');
    const body = functionBody(source, signature);
    if (body) {
      const nameMatch = signature.match(/fn ([a-zA-Z0-9_]+)\s*\(/);
      const name = nameMatch ? nameMatch[1] : signature;
      bodies.push([
        ownerLabel + '::' + name,
        body,
      ]);
    }
  }
  return bodies;
}

export function verifyResponsesContinuationImmutableBoundary(root) {
  const failures = [];
  const sources = Object.fromEntries(
    Object.entries(requiredFiles).map(([key, relativePath]) => [key, readRequired(root, relativePath, failures)]),
  );

  const reqInbound = functionBody(
    sources.reqInbound,
    'pub fn build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01',
  );
  requireText(reqInbound, 'previous: input', requiredFiles.reqInbound + ': ReqInbound02 must remain an adjacent normalization node', failures);

  const restore = functionBody(sources.reqRestore, 'fn restore_local_context_at_req04');
  requireText(restore, 'restore_local_context_from_store_at_req04', requiredFiles.reqRestore + ': Req04 must remain the local continuation restore owner', failures);
  requireText(sources.reqRestore, 'current_payload_start', requiredFiles.reqRestore + ': Req04 must retain the immutable-history/current-suffix boundary', failures);

  const commit = functionBody(
    sources.respCommit,
    'pub(crate) fn commit_or_release_v3_relay_local_continuation_at_resp04',
  );
  requireText(commit, 'commit_at_resp04', requiredFiles.respCommit + ': Resp04 must remain the local continuation save owner', failures);

  const respOutbound = functionBody(
    sources.respOutbound,
    'pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04',
  );
  requireText(respOutbound, 'previous: input', requiredFiles.respOutbound + ': Resp05 must remain an adjacent client projection node', failures);

  const serverFrame = functionBody(
    sources.serverFrame,
    'pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05',
  );
  requireText(serverFrame, 'previous: input', requiredFiles.serverFrame + ': Server06 must remain an adjacent transport frame node', failures);

  const immutableInterval = [
    [requiredFiles.reqInbound, reqInbound],
    [requiredFiles.respOutbound, respOutbound],
    [requiredFiles.serverFrame, serverFrame],
  ];
  for (const [file, source] of immutableInterval) {
    // history_image_cleanup::normalize_v3_history_image_placeholders 是 req_inbound
    // 的合法语义等价归一化（历史轮图片占位符标准化，不可变区允许"只做语义归一"）；
    // 剔除该调用后，任何残留 history 语义操作（修补/恢复/重排）仍必须 fail-fast。
    const historySemanticFree = source.replace(
      /normalize_v3_history_image_placeholders\([^)]*\)/g,
      '',
    );
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'stopless',
      'servertool',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
      'required_action',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': immutable save->restore interval must not own semantic operation ' + forbidden, failures);
    }
    forbidText(historySemanticFree, 'history', file + ': immutable save->restore interval must not own semantic operation history', failures);
  }

  const postCommitSseTransport = functionBody(
    sources.responsesRelayRuntime,
    'pub(crate) fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05',
  );
  requireText(
    postCommitSseTransport,
    'V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER',
    requiredFiles.responsesRelayRuntime + ': SSE transport frames must remain the Server06 projection owner',
    failures,
  );
  requireNonEmpty(postCommitSseTransport, requiredFiles.responsesRelayRuntime + '::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05', failures);
  const sseTransportInterval = allFunctionBodiesMatching(
    sources.responsesRelayRuntime,
    /(^|\n)(pub\(crate\) )?fn (project_v3_responses_client_[a-z0-9_]+|append_v3_responses_client_[a-z0-9_]+|build_v3_server_resp_outbound_06_[a-z0-9_]+|build_v3_runtime_sse_json_frame)\(/g,
    requiredFiles.responsesRelayRuntime,
  );
  // SSE transport owner 检查改为特定函数定义存在（防改名单个函数绕过家族过滤；
  // 用 `fn ` + 括号签名避免被调用点满足）。
  for (const [ownerSymbol, ownerLabel] of [
    ['fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(', 'Server06 SSE transport frames owner'],
    ['fn build_v3_runtime_sse_json_frame(', 'SSE json frame builder'],
    ['fn append_v3_responses_client_function_call_progress_frames(', 'client SSE progress helper'],
    ['fn project_v3_responses_client_event_output_item_done_item(', 'client SSE done-item helper'],
  ]) {
    requireText(
      sources.responsesRelayRuntime,
      ownerSymbol,
      requiredFiles.responsesRelayRuntime + '::' + ownerLabel + ' must exist',
      failures,
    );
  }
  for (const [file, source] of sseTransportInterval) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'stopless',
      'servertool',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
      'required_action',
      'history',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': SSE transport must not own semantic operation ' + forbidden, failures);
    }
  }

  const postCommitClientBodyAdapter = functionBody(
    sources.responsesRelayRuntime,
    'fn project_v3_responses_relay_client_body(',
  );
  requireNonEmpty(postCommitClientBodyAdapter, requiredFiles.responsesRelayRuntime + '::project_v3_responses_relay_client_body', failures);
  const clientBodyAdapterInterval = [
    [requiredFiles.responsesRelayRuntime + '::project_v3_responses_relay_client_body', postCommitClientBodyAdapter],
  ];
  for (const [file, source] of clientBodyAdapterInterval) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'stopless',
      'servertool',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
      'required_action',
      'history',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': post-commit client body adapter must not own semantic operation ' + forbidden, failures);
    }
  }

  const serverHandler = functionBody(
    sources.endpointHandlers,
    'pub(crate) async fn pending_endpoint_after_responses_admission(',
  );
  requireNonEmpty(serverHandler, requiredFiles.serverLib + '::pending_endpoint_after_responses_admission', failures);
  const serverHandlerInterval = [
    [requiredFiles.serverLib + '::pending_endpoint_after_responses_admission', serverHandler],
  ];
  for (const [file, source] of serverHandlerInterval) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'custom_tool_call_output',
      'required_action',
      'history',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': server handler must not own semantic operation ' + forbidden, failures);
    }
  }
  const serverProjectionSources = [
    sources.endpointHandlers,
    sources.websocket,
    sources.executors,
    sources.frameBuilders,
    sources.liveSnapshot,
  ].join('\n');
  const handlerPostCommitProjectionFunctions = allFunctionBodiesMatching(
    serverProjectionSources,
    /(^|\n)(pub(?:\(crate\))? )?(async )?fn (finalize_v3_responses_relay_server_output|prepend_v3_protocol_plan_trace_to_responses_relay_output|prepend_v3_relay_handoff_trace_to_direct_frame|merge_v3_relay_handoff_provider_failure_events_into_direct_frame|merge_v3_direct_handoff_provider_failure_events|project_v3_responses_error_frame_for_request_if_sse|responses_websocket_endpoint|responses_websocket_session|handle_responses_websocket_message_with_mode|send_responses_websocket_sse_stream|send_responses_relay_websocket_sse_stream)\(/g,
    requiredFiles.serverLib,
  );
  requireNonEmpty(
    handlerPostCommitProjectionFunctions.map((entry) => entry[1]).join('\n'),
    requiredFiles.serverLib + '::post-commit server projection functions',
    failures,
  );
  for (const [file, source] of handlerPostCommitProjectionFunctions) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'stopless',
      'servertool',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
      'required_action',
      'history',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': post-commit server projection must not own semantic operation ' + forbidden, failures);
    }
  }

  const storeEncodeTransport = functionBody(
    sources.localContinuation,
    'pub fn encode_v3_local_continuation_immutable_record(',
  );
  const storeDecodeTransport = functionBody(
    sources.localContinuation,
    'pub fn decode_v3_local_continuation_immutable_record(',
  );
  requireNonEmpty(storeEncodeTransport, requiredFiles.localContinuation + '::encode_v3_local_continuation_immutable_record', failures);
  requireNonEmpty(storeDecodeTransport, requiredFiles.localContinuation + '::decode_v3_local_continuation_immutable_record', failures);
  const storeTransportInterval = [
    [requiredFiles.localContinuation + '::encode_v3_local_continuation_immutable_record', storeEncodeTransport],
    [requiredFiles.localContinuation + '::decode_v3_local_continuation_immutable_record', storeDecodeTransport],
  ];
  for (const [file, source] of storeTransportInterval) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'commit_at_resp04',
      'stopless',
      'servertool',
      'tool_outputs',
      'function_call_output',
      'custom_tool_call_output',
      'required_action',
      'history',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': store transport must not own semantic operation ' + forbidden, failures);
    }
  }

  const directKernelCore = functionBody(
    sources.directKernel,
    'fn execute_v3_responses_direct_runtime_kernel_core<',
  );
  requireNonEmpty(directKernelCore, requiredFiles.directKernel + '::execute_v3_responses_direct_runtime_kernel_core', failures);
  const directInterval = [
    [requiredFiles.directKernel + '::execute_v3_responses_direct_runtime_kernel_core', directKernelCore],
  ];
  for (const [file, source] of directInterval) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'custom_tool_call_output',
      'required_action',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': Direct continuation interval must not own semantic operation ' + forbidden, failures);
    }
    for (const forbidden of [
      'strip_active_stopless_pair_and_stale',
      'strip_active_stopless_chat_pair_and_stale',
      'build_stopless_guard_passthrough_visible_payload',
      'canonicalize_v3_hub_resp04_finalized_payload',
      'complete_or_repair_v3_resp03_tool_frames',
    ]) {
      forbidText(source, forbidden, file + ': Direct continuation interval must not own semantic operation ' + forbidden, failures);
    }
  }

  const directStateContinuation = allFunctionBodiesMatching(
    sources.directState,
    /(^|\n)\s*(pub(?:\(crate\))? )?fn (load_for_scope|store_for_scope|clear_for_scope|commit_for_req03_test|no_continuation|with_continuation)\(/g,
    requiredFiles.directState,
  );
  requireNonEmpty(
    directStateContinuation.map((entry) => entry[1]).join('\n'),
    requiredFiles.directState + '::direct continuation state surface',
    failures,
  );
  for (const [file, source] of directStateContinuation) {
    for (const forbidden of [
      'entryOriginRequest',
      'capturedChatRequest',
      'requestSemantics',
      'restore_local_context',
      'custom_tool_call_output',
      'required_action',
      'sanitize',
      'cleanup',
      'repair',
    ]) {
      forbidText(source, forbidden, file + ': Direct continuation state must not own semantic operation ' + forbidden, failures);
    }
  }

  const continuationFeature = featureSection(sources.verificationMap, 'v3.resp03_tool_governance_gap_closeout');
  requireText(continuationFeature, 'npm run verify:responses-continuation-immutable-boundary', requiredFiles.verificationMap + ': continuation feature must require immutable boundary gate', failures);
  requireText(continuationFeature, 'npm run test:responses-continuation-immutable-boundary-red-fixtures', requiredFiles.verificationMap + ': continuation feature must require immutable boundary red fixtures', failures);
  requireText(continuationFeature, 'save->restore interval is immutable', requiredFiles.verificationMap + ': continuation feature must document immutable interval evidence', failures);

  forbidText(
    sources.responsesRelayRuntime,
    'response_has_stopless_activation',
    requiredFiles.responsesRelayRuntime + ': post-commit payload must not reconstruct Stopless control state',
    failures,
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
