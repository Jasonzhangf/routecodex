#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const admissionRoot = path.resolve(v3Root, 'build-contracts', 'architecture-admission', 'repo');
const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT;
const admissionWorkspace = process.env.ROUTECODEX_V3_ADMISSION_WORKSPACE === '1';
const root = sourceRoot
  ? path.resolve(sourceRoot)
  : admissionWorkspace
    ? path.dirname(v3Root)
    : admissionRoot;
const packagePath = sourceRoot || admissionWorkspace
  ? path.join(root, 'package.json')
  : path.join(v3Root, 'package.json');
const rewriteRel = (rel) => {
  if (rel === 'package.json') return packagePath;
  if (rel.startsWith('v3/')) return path.join(v3Root, rel.slice('v3/'.length));
  return path.join(root, rel);
};
const read = (rel) => fs.readFileSync(rewriteRel(rel), 'utf8');

const files = {
  responseCommon: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  responseChatProcess:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  request: 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  responsesRelayRuntime: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  servertoolHooks: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  providerResponsesTransport: 'v3/crates/routecodex-v3-provider-responses/src/transport.rs',
  providerResponsesWire: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
  responseSemanticsTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_response_semantics.rs',
  requestSemanticsTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_request_semantics.rs',
  tests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs',
  responsesLocalTests: 'v3/crates/routecodex-v3-runtime/tests/hub_relay_runtime_closeout.rs',
  manifest: 'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  wiki: 'docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md',
  serverFrameBuilders: 'v3/crates/routecodex-v3-server/src/frame_builders.rs',
  crossKindPublicRegression: 'v3/crates/routecodex-v3-server/tests/req02_field_fold_http.rs',
  packageJson: 'package.json',
};

const text = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, read(file)]));
const responseOwnerSource = [
  text.responseCommon,
  text.responseChatProcess,
].join('\n');
const responseSplitOwner =
  'v3/crates/routecodex-v3-runtime/src/hub_v1/{common.rs,resp_chat_process_03_governed.rs}';
const manifest = YAML.parse(text.manifest);
const packageJson = JSON.parse(text.packageJson);
const failures = [];

const featureId = 'v3.relay_tool_servertool_multiturn_parity_closeout';
const lifecycleId = 'v3.hub_relay.tool_servertool_multiturn_parity';
const requiredScripts = [
  'test:v3-relay-tool-servertool-multiturn-parity-closeout',
  'verify:v3-relay-tool-servertool-multiturn-parity-closeout',
  'test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures',
];
const supportingProtocolScripts = [
  'test:v3-anthropic-codec-characterization',
  'test:v3-openai-chat-codec-characterization',
  'test:v3-gemini-codec-characterization',
];
const requiredSteps = [
  'v3-relay-tool-parity-01',
  'v3-relay-tool-parity-02',
  'v3-relay-tool-parity-04',
  'v3-relay-tool-parity-05',
  'v3-relay-tool-parity-06',
];

if (manifest.lifecycle_id !== lifecycleId) fail(`${files.manifest}: lifecycle_id mismatch`);
if (manifest.owner_feature_id !== featureId) fail(`${files.manifest}: owner_feature_id mismatch`);
if (manifest.call_map_chain_id !== lifecycleId) fail(`${files.manifest}: call_map_chain_id mismatch`);
if (!Array.isArray(manifest.edges) || manifest.edges.length !== requiredSteps.length) {
  fail(`${files.manifest}: expected ${requiredSteps.length} parity edges`);
} else {
  for (const [index, step] of requiredSteps.entries()) {
    const edge = manifest.edges[index];
    if (edge?.step_id !== step || edge.owner_feature_id !== featureId || edge.status !== 'anchored') {
      fail(`${files.manifest}: edge ${step} mismatch`);
    }
  }
}

for (const script of requiredScripts) {
  if (!packageJson.scripts?.[script]) fail(`${files.packageJson}: missing script ${script}`);
}

requireAll(text.request, files.request, [
  'govern_tool_outputs_at_req04',
  'OrphanToolOutput { index: usize, call_id: String }',
  'SideChannelLeaked',
  'current_payload_start',
]);
requireAll(text.crossKindPublicRegression, files.crossKindPublicRegression, [
  'mixed_source_output_kind_preserves_representable_http_pair_without_name_rules',
  'custom_tool_call_output',
  'opaque_client_tool',
  'mixed-kind-call',
]);
forbid(text.request, files.request, /normalize_apply_patch_tool_output_item_at_req04|normalize_apply_patch_output_text_at_req04|APPLY_PATCH_ERROR_TEXT|APPLY_PATCH_RESULT_TEXT/, 'proxy-authored apply_patch executor feedback');
forbid(
  text.request,
  files.request,
  /V3HubAttachmentHistoryPolicy|run_with_attachment_history_policy|govern_attachment_history_at_req04|replace_historical_media_with_placeholder/,
  'historical payload rewrite or attachment placeholder owner',
);
forbid(
  text.providerResponsesWire,
  files.providerResponsesWire,
  /replace_historical|remove_configured_historical|historical_tool_image_placeholder|V3_HISTORICAL_TOOL_IMAGE_PLACEHOLDER_TEXT/,
  'provider wire historical payload rewrite or placeholder owner',
);
forbid(
  text.request,
  files.request,
  /full_materialize_govern_tool_outputs_at_req04/,
  'full payload materialization shortcut',
);
requireAll(text.servertoolHooks, files.servertoolHooks, [
  'current_payload_start',
  'current_v3_tool_thinking_payload_start',
  'compile_v3_tool_thinking_turn_context_at_req04',
  'apply_v3_web_search_request_hook_at_req04',
]);
forbid(
  text.servertoolHooks,
  files.servertoolHooks,
  /strip_active_stopless_pair_and_stale|strip_active_stopless_chat_pair_and_stale|strip_stopless_internal_control_echo|strip_stopless_internal_tools|finalize_stopless_terminal_responses_payload|build_stopless_passthrough_visible_payload|build_stopless_guard_passthrough_visible_payload|lift_additional_tools_into_provider_tool_surface/,
  'history-wide Stopless cleanup or response repair',
);
requireAll(text.providerResponsesTransport, files.providerResponsesTransport, [
  'pub fn is_v3_anthropic_provider_request_header_name',
  'pub struct V3Transport13ResponsesRequest',
]);
forbid(
  text.providerResponsesTransport,
  files.providerResponsesTransport,
  /normalize_responses_additional_tools_for_provider_request|responses_http_provider_request_lifts_additional_tools_to_protocol_tools/,
  'Responses HTTP additional_tools global lift',
);
forbid(
  text.providerResponsesTransport,
  files.providerResponsesTransport,
  /build_anthropic_messages_body|Anthropic protocol conversion/,
  'provider transport protocol conversion outside Chat Process',
);
requireAll(text.responseCommon, files.responseCommon, ['pub enum V3HubRelayToolKind']);
requireAll(text.responseChatProcess, files.responseChatProcess, [
  'pub(crate) fn classify_v3_hub_relay_tool_kind',
  'fn inspect_v3_resp03_finish_reason',
  'fn project_v3_apply_patch_freeform_calls_at_resp03',
  'normalize_v3_apply_patch_freeform_input_for_client',
  'tool_call_kinds',
  'SideChannelLeaked',
  'servertool_action',
  'V3HubServertoolResponseAction::FollowupRequired',
]);
forbid(
  text.responseChatProcess,
  files.responseChatProcess,
  /complete_or_repair_v3_resp03_tool_frames/,
  'fabricating Responses tool-continuation repair in Resp03',
);
requireAll(text.servertoolHooks, files.servertoolHooks, [
  'apply_v3_tool_call_servertool_hook_at_resp03',
]);
const resp03GovernStart = text.responseChatProcess.indexOf('fn govern_v3_hub_relay_response(');
const resp03GovernEnd = text.responseChatProcess.indexOf('\nstruct V3Resp03ProtocolGovernance', resp03GovernStart);
if (resp03GovernStart < 0 || resp03GovernEnd < 0) {
  fail(`${files.responseChatProcess}: unable to isolate Resp03 response governance orchestrator`);
} else {
  const resp03Govern = text.responseChatProcess.slice(resp03GovernStart, resp03GovernEnd);
  requireOrdered(resp03Govern, files.responseChatProcess, [
    'harvest_v3_think_blocks_at_resp03',
    'inspect_v3_resp03_finish_reason',
    'apply_v3_tool_call_servertool_hook_at_resp03',
    'project_v3_apply_patch_freeform_calls_at_resp03',
  ], 'Resp03 response governance');
  forbid(
    resp03Govern,
    files.responseChatProcess,
    /apply_v3_stopless_response_hook_at_resp03/,
    'retired stopless response hook in Resp03 orchestrator',
  );
}
const clientSseProjectionStart = text.responsesRelayRuntime.indexOf(
  'fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05',
);
const clientSseProjectionEnd = text.responsesRelayRuntime.indexOf(
  '\nfn project_v3_responses_client_event_output_item_done_item',
  clientSseProjectionStart,
);
if (clientSseProjectionStart < 0 || clientSseProjectionEnd < 0) {
  fail(`${files.responsesRelayRuntime}: unable to isolate Responses client SSE projection owner`);
} else {
  const clientSseProjection = text.responsesRelayRuntime.slice(
    clientSseProjectionStart,
    clientSseProjectionEnd,
  );
  requireAll(clientSseProjection, files.responsesRelayRuntime, [
    'Some("failed")',
    '"response.failed"',
    '"response.incomplete"',
    '"response.in_progress"',
    '"response.completed"',
  ]);
  requireOrdered(clientSseProjection, files.responsesRelayRuntime, [
    '"response.in_progress"',
    '"response.completed"',
  ]);
  // 非协议终止帧由文件级 forbid 统一判定（覆盖本切片），此处不重复声明。
  forbid(
    clientSseProjection,
    files.responsesRelayRuntime,
    /"response\.requires_action"/,
    'response.requires_action client SSE terminal projection',
  );
}
// 整个 Responses 客户端帧 owner 文件都不允许出现非协议终止帧：新增的
// client-frame helper 也必须受约束，不能因为切片边界而逃过门禁。注释里可以
// 说明被禁止的协议终止符，因此这里只在去掉注释后的代码视图上判定。
// `data:` 后的空白不固定，`data:[DONE]` / `data:  [DONE]` 同样是合法 SSE 编码。
forbid(
  stripRustComments(text.responsesRelayRuntime),
  files.responsesRelayRuntime,
  /"response\.done"|data:\s*\[DONE\]/,
  'non-Responses client SSE terminator (response.done / [DONE]) in the Responses client framing owner',
);
{
  forbid(
    text.serverFrameBuilders,
    files.serverFrameBuilders,
    /event: (?:error|response\.failed)/,
    'client error event construction is forbidden',
  );
}
forbid(
  text.responsesRelayRuntime,
  files.responsesRelayRuntime,
  /v3_runtime_sse_event_has_tool_call|v3_runtime_sse_item_is_tool_call/,
  'SSE transport tool-call semantic inference',
);

const runFromNormalizedStart = text.request.indexOf('pub fn run_from_normalized(');
const req04Start = text.request.indexOf('fn run_from_normalized_with_events');
if (runFromNormalizedStart < 0 || req04Start < 0 || !(runFromNormalizedStart < req04Start)) {
  fail(`${files.request}: unable to isolate Req04 request governance owner`);
} else {
  const req04Owner = text.request.slice(req04Start);
  requireOrdered(req04Owner, files.request, [
    'current_payload_start',
    'govern_tool_outputs_at_req04',
    'run_servertool_profile',
    'build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02',
  ]);
}
requireAll(text.tests, files.tests, [
  'protocol_transport_matrix_uses_one_chat_process_governance_path',
  'apply_patch_response_is_projected_to_freeform_custom_tool_before_client_projection',
  'apply_patch_tool_output_error_is_preserved_without_continuation_state',
  'apply_patch_legacy_function_call_accepts_custom_output_after_client_projection',
  'request_governance_rejects_orphan_output_and_preserves_missing_call_id',
  'response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit',
  'responses_sse_arbitrary_chunks_preserve_delta_order_and_terminal_tool_order',
  'provider_and_client_payloads_reject_routecodex_control_leakage',
  'V3HubRelayToolKind::ApplyPatch',
  'V3HubRelayToolKind::Mcp',
  'V3HubRelayToolKind::Native',
  'V3HubEntryProtocol::Anthropic',
  'V3HubEntryProtocol::OpenAiChat',
  'V3HubEntryProtocol::Gemini',
  'V3HubTransportIntent::Sse',
  'data:image/png;base64,CURRENT',
  'earlier_attachment_is_cleaned_while_inline_tool_text_and_latest_image_survive',
  'attachment_history_bytes_survive_while_req04_cleans_the_canonical_wire',
  'attachment_history_missing_resource_is_preserved_as_client_data',
]);
requireAll(text.responseSemanticsTests, files.responseSemanticsTests, [
  'resp03_preserves_completed_tool_call_response_before_tool_governance',
  'resp05_consumes_resp03_governed_payload_without_semantic_repair',
]);
requireAll(text.requestSemanticsTests, files.requestSemanticsTests, [
]);
requireAll(text.functionMap, files.functionMap, [
  'feature_id: v3.resp03_tool_governance_gap_closeout',
  'resp05_consumes_resp03_governed_payload_without_semantic_repair',
  'apply_v3_tool_call_servertool_hook_at_resp03',
]);
requireAll(text.mainlineMap, files.mainlineMap, [
  'chain_id: v3.resp03_tool_governance_gap_closeout',
  'v3-resp03-tool-governance-01',
  'v3-resp03-tool-governance-06',
]);
requireAll(text.verificationMap, files.verificationMap, [
  'feature_id: v3.resp03_tool_governance_gap_closeout',
  'Resp03 owns response tool/servertool governance before client projection',
]);
requireAll(text.responsesLocalTests, files.responsesLocalTests, [
  'provider_error_closeout_returns_terminal_exhaustion_instead_of_hanging',
  'responses_relay_json_and_sse_enter_fixed_topology_without_p6_direct_nodes',
  'assert_eq!(captures.len(), 2);',
  'Responses Relay client SSE transport must not raw-pass provider argument event payloads around Hub',
  'responses_relay_provider_duplicate_tool_identity_projects_typed_error_after_exhaustion',
]);

requireAll(text.functionMap, files.functionMap, [featureId, lifecycleId]);
requireAll(text.mainlineMap, files.mainlineMap, [featureId, lifecycleId, ...requiredSteps]);
requireAll(text.verificationMap, files.verificationMap, [featureId, lifecycleId]);
requireAll(text.resourceMap, files.resourceMap, [featureId]);
requireAll(text.wiki, files.wiki, [featureId, lifecycleId, 'v3-relay-tool-parity-01']);

requireAll(text.resourceMap, files.resourceMap, [
  'v3.hub.tool_governance_truth',
]);
for (const script of requiredScripts) {
  requireAll(text.functionMap, files.functionMap, [`npm run ${script}`]);
  requireAll(text.verificationMap, files.verificationMap, [`npm run ${script}`]);
}
for (const script of supportingProtocolScripts) {
  if (!packageJson.scripts?.[script]) fail(`${files.packageJson}: missing script ${script}`);
  requireAll(text.verificationMap, files.verificationMap, [`npm run ${script}`]);
  requireAll(text.wiki, files.wiki, [`npm run ${script}`]);
}

const requestWrongOwnerAuditSource = stripStringLiterals(text.request);
const responseWrongOwnerAuditSource = stripStringLiterals(responseOwnerSource);
forbid(requestWrongOwnerAuditSource, files.request, /handler|server_frame|provider_runtime|transport_socket|websocket/i, 'wrong owner repair vocabulary in request governance');
forbid(responseWrongOwnerAuditSource, responseSplitOwner, /handler|server_frame|provider_runtime|transport_socket|websocket/i, 'wrong owner repair vocabulary in response governance');
forbid(text.request + responseOwnerSource, 'V3 Relay tool parity Rust owner', /read_dir|libloading/i, 'dynamic filesystem hook');
const metadataCenterLeakOwnerSource = text.request + responseOwnerSource;
const metadataCenterLegalIdentifierStripped = metadataCenterLeakOwnerSource.replaceAll(
  '::is_metadata_center_local_search',
  '',
);
forbid(metadataCenterLegalIdentifierStripped, 'V3 Relay tool parity Rust owner', /metadata_center[\s\S]{0,120}(?:insert|write|payload)|payload[\s\S]{0,120}metadata_center/i, 'MetadataCenter payload/control leakage');
forbid(text.tests, files.tests, /fallback/i, 'fallback in parity tests');
forbid(text.responsesLocalTests, files.responsesLocalTests, /fallback/i, 'fallback in Responses Relay closeout tests');

if (failures.length) {
  console.error('[verify:v3-relay-tool-servertool-multiturn-parity-closeout] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-relay-tool-servertool-multiturn-parity-closeout] ok');

function requireAll(source, owner, phrases) {
  for (const phrase of phrases) {
    if (!source.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbid(source, owner, pattern, label) {
  if (pattern.test(source)) fail(`${owner}: forbidden ${label} (${pattern})`);
}

// 门禁只判定代码，不判定说明文字：注释需要能点名被禁止的协议终止符。
// 必须是字符串/字符/注释感知的扫描：`//` 出现在字符串字面量里（例如 URL）
// 时不能把该行后续代码当作注释清掉，否则真实违规会被遮蔽。
// Rust 字符字面量形如 `'a'` / `'\n'` / `'\\'` / `'\u{1F600}'`；`&'static str`
// 这类生命周期不是字面量。只有在很短的窗口内闭合才按字面量处理，否则视为
// 生命周期，避免把后续代码整段吞进字面量状态而遮蔽真实违规。
function rustCharLiteralLength(source, index) {
  if (source[index] !== "'") return 0;
  let cursor = index + 1;
  if (source[cursor] === '\\') {
    cursor += 1;
    const escape = source[cursor];
    if (escape === 'u') {
      const open = source.indexOf('{', cursor);
      const close = open < 0 ? -1 : source.indexOf('}', open);
      if (open < 0 || close < 0 || close - open > 10) return 0;
      cursor = close + 1;
    } else if (escape === 'x') {
      cursor += 3;
    } else {
      cursor += 1;
    }
  } else {
    const point = source.codePointAt(cursor);
    if (point === undefined) return 0;
    cursor += String.fromCodePoint(point).length;
  }
  return source[cursor] === "'" ? cursor + 1 - index : 0;
}

// Rust raw 字符串前缀 `r"` / `r#"` / `r##"`…，哈希数可达 255。必须按实际
// 哈希数量判定，固定窗口会在 >=11 个 `#` 时误判成普通字符串，从而把后续
// 真实违规当作注释清掉（fail-open）。
function rustRawStringOpenLength(source, index) {
  if (source[index] !== 'r') return 0;
  let cursor = index + 1;
  while (source[cursor] === '#') cursor += 1;
  if (source[cursor] !== '"') return 0;
  return cursor + 1 - index;
}

function stripRustComments(source) {
  let out = '';
  let index = 0;
  let state = 'code';
  let rawStringHashes = '';
  let blockCommentDepth = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'lineComment';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'blockComment';
        blockCommentDepth = 1;
        index += 2;
        continue;
      }
      const rawOpenLength = rustRawStringOpenLength(source, index);
      if (rawOpenLength > 0) {
        const prefix = source.slice(index, index + rawOpenLength);
        rawStringHashes = prefix.slice(1, -1);
        // 保留 `r#"` 前缀，使 raw 字符串内容保持可见。
        out += prefix;
        index += rawOpenLength;
        state = 'rawString';
        continue;
      }
      if (char === '"') {
        state = 'string';
        out += char;
        index += 1;
        continue;
      }
      if (char === "'") {
        const length = rustCharLiteralLength(source, index);
        if (length > 0) {
          out += source.slice(index, index + length);
          index += length;
          continue;
        }
        out += char;
        index += 1;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    if (state === 'lineComment') {
      if (char === '\n') {
        state = 'code';
        out += char;
      }
      index += 1;
      continue;
    }
    if (state === 'blockComment') {
      // Rust 块注释可嵌套；只在深度归零时结束，否则内层 `*/` 会提前关闭
      // 注释并把后续说明文字当成代码判定（false positive）。
      if (char === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 2;
        continue;
      }
      if (char === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) state = 'code';
        continue;
      }
      if (char === '\n') out += char;
      index += 1;
      continue;
    }
    if (state === 'rawString') {
      const closing = `"${'#'.repeat(rawStringHashes.length)}`;
      if (source.startsWith(closing, index)) {
        out += closing;
        index += closing.length;
        state = 'code';
        rawStringHashes = '';
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    // string literal: keep the bytes so literal payloads stay visible to the
    // forbids, and honour escapes.
    out += char;
    if (char === '\\') {
      if (next !== undefined) out += next;
      index += 2;
      continue;
    }
    if (char === '"') {
      state = 'code';
    }
    index += 1;
  }
  return out;
}

function requireOrdered(source, owner, phrases, label = 'Req04') {
  let previousIndex = -1;
  for (const phrase of phrases) {
    const index = source.indexOf(phrase);
    if (index < 0) {
      fail(`${owner}: missing ordered ${label} step ${phrase}`);
      return;
    }
    if (index <= previousIndex) {
      fail(`${owner}: ${label} step out of order ${phrase}`);
      return;
    }
    previousIndex = index;
  }
}

function stripStringLiterals(source) {
  return source.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function fail(message) {
  failures.push(message);
}
