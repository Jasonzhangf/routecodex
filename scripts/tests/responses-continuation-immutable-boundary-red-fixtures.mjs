import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyResponsesContinuationImmutableBoundary } from '../architecture/verify-responses-continuation-immutable-boundary.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requiredFiles = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
  'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
  'v3/crates/routecodex-v3-server/src/websocket.rs',
  'v3/crates/routecodex-v3-server/src/executors.rs',
  'v3/crates/routecodex-v3-server/src/frame_builders.rs',
  'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs',
  'docs/architecture/v3-verification-map.yml',
];

function copyFixtureRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-continuation-immutable-'));
  for (const relativePath of requiredFiles) {
    const source = path.join(repoRoot, relativePath);
    const target = path.join(tmp, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return tmp;
}

function mutate(root, relativePath, marker, replacement) {
  const target = path.join(root, relativePath);
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(marker)) throw new Error(relativePath + ': mutation marker missing');
  fs.writeFileSync(target, source.replace(marker, replacement));
}

function expectFailure(name, mutateFixture, expectedText) {
  const root = copyFixtureRoot();
  try {
    mutateFixture(root);
    const failures = verifyResponsesContinuationImmutableBoundary(root);
    if (!failures.some((failure) => failure.includes(expectedText))) {
      console.error(name + ': expected failure containing ' + expectedText);
      console.error(failures.join('\n'));
      process.exit(1);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

expectFailure(
  'ReqInbound cannot rebuild saved history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
    'previous: input,',
    'let _ = capturedChatRequest;\n        previous: input,',
  ),
  'capturedChatRequest',
);

expectFailure(
  'RespOutbound cannot repair tool output history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
    'previous: input,',
    'let _ = function_call_output;\n        previous: input,',
  ),
  'function_call_output',
);

expectFailure(
  'Server frame cannot restore continuation context',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
    'V3ServerRespOutbound06ClientFrame { previous: input }',
    '{ let _ = restore_local_context; V3ServerRespOutbound06ClientFrame { previous: input } }',
  ),
  'restore_local_context',
);

expectFailure(
  'SSE transport cannot repair tool output history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(',
    'fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_repair(\n    let _ = tool_outputs;\n    fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(',
  ),
  'SSE transport must not own semantic operation tool_outputs',
);

expectFailure(
  'SSE transport cannot rewrite history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER;',
    'let _ = rewrite_history;\n    let _ = V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER;',
  ),
  'SSE transport must not own semantic operation history',
);

expectFailure(
  'Post-commit client body adapter cannot commit continuation state',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_relay_client_body(',
    'fn project_v3_responses_relay_client_body(\n    let _ = commit_at_resp04;\n',
  ),
  'post-commit client body adapter must not own semantic operation commit_at_resp04',
);

expectFailure(
  'Post-commit client body adapter cannot rewrite history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_relay_client_body(',
    'fn project_v3_responses_relay_client_body(\n    let _ = sanitize_history;\n',
  ),
  'post-commit client body adapter must not own semantic operation history',
);

expectFailure(
  'Post-commit client body adapter owner symbol removed',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_relay_client_body(',
    'fn project_v3_responses_client_body_renamed(',
  ),
  'immutable-interval owner body is missing',
);

expectFailure(
  'SSE done-item helper cannot clean history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_client_event_output_item_done_item(',
    'fn project_v3_responses_client_event_output_item_done_item(\n    let _ = sanitize_history;\n',
  ),
  'SSE transport must not own semantic operation history',
);

expectFailure(
  'SSE done-item helper cannot write control state into payload',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_client_event_output_item_done_item(',
    'fn project_v3_responses_client_event_output_item_done_item(\n    let _ = commit_at_resp04;\n',
  ),
  'SSE transport must not own semantic operation commit_at_resp04',
);

expectFailure(
  'SSE progress helper cannot repair tool frames',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn append_v3_responses_client_function_call_progress_frames(',
    'fn append_v3_responses_client_function_call_progress_frames(\n    let _ = function_call_output;\n',
  ),
  'SSE transport must not own semantic operation function_call_output',
);

expectFailure(
  'SSE progress helper surface removed',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn append_v3_responses_client_function_call_progress_frames(',
    'fn append_v3_responses_removed_client_frames(',
  ),
  'client SSE progress helper',
);

expectFailure(
  'SSE done-item helper owner symbol removed',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_client_event_output_item_done_item(',
    'fn project_v3_responses_removed_done_item(',
  ),
  'client SSE done-item helper',
);

expectFailure(
  'SSE json frame builder owner symbol removed',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn build_v3_runtime_sse_json_frame(',
    'fn build_v3_runtime_removed_json_frame(',
  ),
  'SSE json frame builder',
);

expectFailure(
  'Server handler cannot commit continuation state',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
    'async fn pending_endpoint_after_responses_admission(',
    'async fn pending_endpoint_after_responses_admission(\n    let _ = commit_at_resp04;\n',
  ),
  'server handler must not own semantic operation commit_at_resp04',
);

expectFailure(
  'Server handler cannot rewrite history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
    'let request_id = request_identity.request_id.clone();',
    'let _ = merge_history;\n    let request_id = request_identity.request_id.clone();',
  ),
  'server handler must not own semantic operation history',
);

expectFailure(
  'Server handler owner symbol renamed',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
    'async fn pending_endpoint_after_responses_admission(',
    'async fn pending_endpoint_renamed(',
  ),
  'immutable-interval owner body is missing',
);

expectFailure(
  'Server handler cannot run Stopless request hook',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
    'fn finalize_v3_responses_relay_server_output(',
    'fn finalize_v3_responses_relay_server_output(\n    let _ = apply_v3_stopless_request_hook_at_req04;\n',
  ),
  'post-commit server projection must not own semantic operation stopless',
);

expectFailure(
  'Server handler cannot govern tool outputs',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
    'fn finalize_v3_responses_relay_server_output(',
    'fn finalize_v3_responses_relay_server_output(\n    let _ = govern_tool_outputs_at_req04;\n',
  ),
  'post-commit server projection must not own semantic operation tool_outputs',
);

expectFailure(
  'Server handler cannot run servertool response hook',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
    'fn finalize_v3_responses_relay_server_output(',
    'fn finalize_v3_responses_relay_server_output(\n    let _ = apply_v3_stop_servertool_hook_at_resp03;\n',
  ),
  'post-commit server projection must not own semantic operation servertool',
);

expectFailure(
  'Store transport cannot restore continuation context',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
    'serde_json::to_vec(record).map_err(|error| V3LocalContinuationError::Codec {',
    'let _ = restore_local_context;\n    serde_json::to_vec(record).map_err(|error| V3LocalContinuationError::Codec {',
  ),
  'store transport must not own semantic operation restore_local_context',
);

expectFailure(
  'Store transport cannot rewrite history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
    'serde_json::from_slice(encoded).map_err(|error| V3LocalContinuationError::Codec {',
    'let _ = sanitize_history;\n    serde_json::from_slice(encoded).map_err(|error| V3LocalContinuationError::Codec {',
  ),
  'store transport must not own semantic operation history',
);

expectFailure(
  'Store transport owner symbol removed',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/local_continuation.rs',
    'pub fn encode_v3_local_continuation_immutable_record(',
    'pub fn encode_v3_local_continuation_record_renamed(',
  ),
  'immutable-interval owner body is missing',
);

expectFailure(
  'Direct kernel cannot repair tool frames in continuation interval',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    'fn execute_v3_responses_direct_runtime_kernel_core<',
    'fn execute_v3_responses_direct_runtime_kernel_core<\n    let _ = complete_or_repair_v3_resp03_tool_frames;\n',
  ),
  'Direct continuation interval must not own semantic operation complete_or_repair_v3_resp03_tool_frames',
);

expectFailure(
  'Direct kernel cannot sanitize history in continuation interval',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    'fn execute_v3_responses_direct_runtime_kernel_core<',
    'fn execute_v3_responses_direct_runtime_kernel_core<\n    let _ = sanitize_history;\n',
  ),
  'Direct continuation interval must not own semantic operation sanitize',
);

expectFailure(
  'Post-commit server projection cannot rewrite tool output history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
    'fn finalize_v3_responses_relay_server_output(',
    'fn finalize_v3_responses_relay_server_output(\n    let _ = rewrite_tool_outputs_for_client;\n',
  ),
  'post-commit server projection must not own semantic operation tool_outputs',
);

expectFailure(
  'Post-commit server projection cannot run stopless hook',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/live_snapshot.rs',
    'fn finalize_v3_responses_relay_server_output(',
    'fn finalize_v3_responses_relay_server_output(\n    let _ = apply_v3_stopless_request_hook_at_req04;\n',
  ),
  'post-commit server projection must not own semantic operation stopless',
);

expectFailure(
  'SSE done-item helper cannot run Stopless hook',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn project_v3_responses_client_event_output_item_done_item(',
    'fn project_v3_responses_client_event_output_item_done_item(\n    let _ = apply_v3_stopless_request_hook_at_req04;\n',
  ),
  'SSE transport must not own semantic operation stopless',
);

expectFailure(
  'Responses WebSocket session cannot restore continuation context',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/websocket.rs',
    'async fn responses_websocket_session(',
    'async fn responses_websocket_session(\n    let _ = restore_local_context;\n',
  ),
  'post-commit server projection must not own semantic operation restore_local_context',
);

expectFailure(
  'Responses WebSocket message handler cannot repair tool frames',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/websocket.rs',
    'async fn handle_responses_websocket_message_with_mode(',
    'async fn handle_responses_websocket_message_with_mode(\n    let _ = complete_or_repair_v3_resp03_tool_frames;\n',
  ),
  'post-commit server projection must not own semantic operation',
);

expectFailure(
  'Responses WebSocket SSE stream cannot run servertool hook',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-server/src/websocket.rs',
    'async fn send_responses_websocket_sse_stream(',
    'async fn send_responses_websocket_sse_stream(\n    let _ = apply_v3_tool_call_servertool_hook_at_resp03;\n',
  ),
  'post-commit server projection must not own semantic operation servertool',
);

expectFailure(
  'Post-commit payload stopless inference revived',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    'fn read_v3_runtime_response_status(',
    'fn response_has_stopless_activation(value: &serde_json::Value) -> bool { false }\nfn read_v3_runtime_response_status(',
  ),
  'post-commit payload must not reconstruct Stopless control state',
);

const mutatedCount = [
  'ReqInbound cannot rebuild saved history',
  'RespOutbound cannot repair tool output history',
  'Server frame cannot restore continuation context',
  'SSE transport cannot repair tool output history',
  'SSE transport cannot rewrite history',
  'Post-commit payload stopless inference revived',
  'SSE done-item helper cannot run Stopless hook',
  'Responses WebSocket session cannot restore continuation context',
  'Responses WebSocket message handler cannot repair tool frames',
  'Responses WebSocket SSE stream cannot run servertool hook',
  'SSE done-item helper cannot clean history',
  'SSE done-item helper cannot write control state into payload',
  'SSE progress helper cannot repair tool frames',
  'Direct kernel cannot repair tool frames in continuation interval',
  'Direct kernel cannot sanitize history in continuation interval',
  'Post-commit server projection cannot rewrite tool output history',
  'Post-commit server projection cannot run stopless hook',
  'SSE progress helper owner symbol removed',
  'SSE done-item helper owner symbol removed',
  'SSE json frame builder owner symbol removed',
  'Post-commit client body adapter cannot commit continuation state',
  'Post-commit client body adapter cannot rewrite history',
  'Post-commit client body adapter owner symbol removed',
  'Server handler cannot commit continuation state',
  'Server handler cannot rewrite history',
  'Server handler owner symbol renamed',
  'Server handler cannot run Stopless request hook',
  'Server handler cannot govern tool outputs',
  'Server handler cannot run servertool response hook',
  'Store transport cannot restore continuation context',
  'Store transport cannot rewrite history',
  'Store transport owner symbol removed',
].length;
console.log(`Responses continuation immutable boundary red fixtures passed (${mutatedCount} mutations rejected).`);
