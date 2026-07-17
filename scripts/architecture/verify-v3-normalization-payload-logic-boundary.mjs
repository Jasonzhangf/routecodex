#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const hubPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const relayRequestPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs';
const responsesRelayRuntimePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs';
const openaiChatCodecPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs';
const geminiCodecPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs';
const protocolBoundaryManifestPath = 'docs/architecture/manifests/v3.protocol_normalization_tool_governance_boundary.mainline.yml';
const hub = readFileSync(resolve(root, hubPath), 'utf8');
const relayRequest = readFileSync(resolve(root, relayRequestPath), 'utf8');
const responsesRelayRuntime = readFileSync(resolve(root, responsesRelayRuntimePath), 'utf8');
const openaiChatCodec = readFileSync(resolve(root, openaiChatCodecPath), 'utf8');
const geminiCodec = readFileSync(resolve(root, geminiCodecPath), 'utf8');
const protocolBoundaryManifest = readFileSync(resolve(root, protocolBoundaryManifestPath), 'utf8');

function fail(message) {
  console.error(`[verify:v3-normalization-payload-logic-boundary] ${message}`);
  process.exit(1);
}

function functionBody(source, marker, label = marker) {
  const start = source.indexOf(marker);
  if (start < 0) fail(`missing boundary function ${label}`);
  const open = source.indexOf('{', start);
  if (open < 0) fail(`missing body for ${label}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  fail(`unterminated boundary function ${label}`);
}

function requireAll(text, owner, phrases) {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) fail(`${owner}: missing ${phrase}`);
  }
}

function forbidAll(text, owner, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) fail(`${owner}: forbidden ${pattern}`);
  }
}

const boundaries = [
  {
    owner: 'ReqInbound02 entry normalization',
    text: functionBody(hub, 'pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01'),
    required: ['previous: input', 'V3HubRequestSemanticProtocol::Chat'],
  },
  {
    owner: 'RespInbound02 entry normalization',
    text: functionBody(hub, 'pub fn build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01'),
    required: ['previous: input', 'normalized_kind'],
  },
  {
    owner: 'ReqOutbound07 provider semantic projection',
    text: functionBody(hub, 'pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06'),
    required: ['previous: input', 'provider_protocol'],
  },
  {
    owner: 'ProviderReqOutbound08 wire boundary',
    text: functionBody(hub, 'pub fn build_v3_provider_req_outbound_08_from_v3_hub_req_outbound_07'),
    required: ['previous: input'],
  },
  {
    owner: 'ProviderReqOutbound09 transport boundary',
    text: functionBody(hub, 'pub fn build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08'),
    required: ['previous: input'],
  },
  {
    owner: 'ProviderReqOutbound09 payload projection',
    text: functionBody(hub, 'fn into_provider_semantic_payload'),
    required: ['payload', '.0'],
  },
  {
    owner: 'RespOutbound05 client semantic projection',
    text: functionBody(hub, 'pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04'),
    required: ['previous: input'],
  },
  {
    owner: 'ServerRespOutbound06 frame projection',
    text: functionBody(hub, 'pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05'),
    required: ['previous: input'],
  },
  {
    owner: 'Relay response normalize wrapper',
    text: functionBody(hub, 'fn normalize_v3_hub_relay_response'),
    required: ['build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01'],
  },
];

const forbiddenLogic = [
  /\btool_calls?\b/,
  /\bservertool\b/i,
  /\bstopless\b/i,
  /\bhook\b/i,
  /\bschema\b/i,
  /\bgovern/i,
  /\breasoningStop\b/,
  /\bapply_patch\b/,
  /\brequired_action\b/,
  /\bfunction_call(?:_output)?\b/,
  /\bcustom_tool_call(?:_output)?\b/,
  /\btool_call(?:_output)?\b/,
  /\brestore\b/i,
  /\brepair\b/i,
  /\bsanitize\b/i,
  /\bcanonical_context\b/,
  /\bV3HubContinuationCommit\b/,
  /\bArc::clone\b/,
  /\bserde_json::(?:to_value|from_value|to_string|from_str|to_vec|from_slice)\b/,
  /\bpayload\.clone\s*\(/,
  /\bValue::clone\b/,
];

const forbiddenToolGovernanceInProtocolMapping = [
  /\bvalidate_message_tool_identity\b/,
  /\bvalidate_contents\b/,
  /\bdeclared(?:_function_calls)?\b/,
  /\bBTreeSet\b/,
  /\btool_call_id\b/,
  /\bfunctionResponse\b/,
  /\bfunctionCall\b.*\bfunctionResponse\b/s,
  /\bInvalidToolCallIdentity\b/,
  /\bInvalidFunctionResponseIdentity\b/,
];

for (const boundary of boundaries) {
  requireAll(boundary.text, boundary.owner, boundary.required);
  forbidAll(boundary.text, boundary.owner, forbiddenLogic);
}

const protocolMappingBoundaries = [
  {
    owner: 'OpenAI Chat request inbound protocol mapping',
    text: functionBody(openaiChatCodec, 'pub fn characterize_v3_openai_chat_client_input_to_hub_semantic'),
    required: ['EntryProtocolNotOpenAiChat', 'validate_request'],
  },
  {
    owner: 'OpenAI Chat request shape validation',
    text: functionBody(openaiChatCodec, 'fn validate_request'),
    required: ['reject_side_channel_fields', 'MessagesNotArray'],
  },
  {
    owner: 'OpenAI Chat response inbound protocol mapping',
    text: functionBody(openaiChatCodec, 'pub fn characterize_v3_openai_chat_provider_raw_to_hub_response_semantic'),
    required: ['ProviderProtocolNotOpenAiChat', 'validate_response'],
  },
  {
    owner: 'OpenAI Chat JSON response shape validation',
    text: functionBody(openaiChatCodec, 'fn validate_json_response'),
    required: ['ChoicesNotArray'],
  },
  {
    owner: 'Gemini request inbound protocol mapping',
    text: functionBody(geminiCodec, 'pub fn characterize_v3_gemini_client_input_to_hub_semantic'),
    required: ['EntryProtocolNotGemini', 'validate_request'],
  },
  {
    owner: 'Gemini request shape validation',
    text: functionBody(geminiCodec, 'fn validate_request'),
    required: ['reject_side_channel_fields', 'ContentsNotArray'],
  },
  {
    owner: 'Gemini content shape validation',
    text: functionBody(geminiCodec, 'fn validate_content_shapes'),
    required: ['PartsNotArray'],
  },
];

for (const boundary of protocolMappingBoundaries) {
  requireAll(boundary.text, boundary.owner, boundary.required);
  forbidAll(boundary.text, boundary.owner, forbiddenToolGovernanceInProtocolMapping);
}

const requestRun = functionBody(relayRequest, 'fn run_from_normalized_with_events');
requireAll(requestRun, 'ReqChatProcess tool governance owner', [
  'restore_local_context_at_req04',
  'govern_tool_outputs_at_req04',
  'govern_attachment_history_at_req04',
  'run_servertool_profile',
  'build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03',
]);
if (requestRun.indexOf('restore_local_context_at_req04') > requestRun.indexOf('run_servertool_profile')) {
  fail('ReqChatProcess tool governance owner: servertool hook must run after context restore');
}

const responseGovern = functionBody(hub, 'fn govern_v3_hub_relay_response');
requireAll(responseGovern, 'RespChatProcess tool governance owner', [
  'tool_calls.push',
  'V3HubServertoolResponseAction::FollowupRequired',
  'V3HubResponseTerminality::NonTerminal',
]);
forbidAll(responseGovern, 'RespChatProcess tool governance owner', [
  /\bV3HubContinuationCommit\b/,
  /\bbuild_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03\b/,
  /\bbuild_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04\b/,
]);

const responseRuntime = functionBody(responsesRelayRuntime, 'fn run_json_response_hooks');
if (responseRuntime.indexOf('hooks.govern') > responseRuntime.indexOf('hooks.commit')) {
  fail('Responses Relay response runtime: Chat Process govern must run before continuation commit');
}

requireAll(protocolBoundaryManifest, 'V3 protocol normalization boundary manifest', [
  'ProviderReqCompat06ProviderCompat',
  'ProviderRespCompat02ProviderCompat',
  'tool_governance: forbidden',
  'fallback_or_silent_repair: forbidden',
]);
const compatSections = [
  {
    owner: 'ProviderReqCompat06ProviderCompat manifest node',
    text: protocolBoundaryManifest.match(/node_id: ProviderReqCompat06ProviderCompat[\s\S]*?(?=\n  - node_id:|\nedges:)/)?.[0] ?? '',
  },
  {
    owner: 'ProviderRespCompat02ProviderCompat manifest node',
    text: protocolBoundaryManifest.match(/node_id: ProviderRespCompat02ProviderCompat[\s\S]*?(?=\n  - node_id:|\nedges:)/)?.[0] ?? '',
  },
];
for (const section of compatSections) {
  if (!section.text) fail(`${section.owner}: missing manifest section`);
  forbidAll(section.text, section.owner, [/\btool governance\b/i, /\btool_governance:\s*allowed\b/i, /\bfallback\b.*\bsuccess\b/i]);
}

console.log('[verify:v3-normalization-payload-logic-boundary] ok');
