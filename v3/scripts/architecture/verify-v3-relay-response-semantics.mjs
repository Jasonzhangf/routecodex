#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const splitSourceDir = 'v3/crates/routecodex-v3-runtime/src/hub_v1';
function readRelayResponseSourceSurface() {
  const rootSource = readFileSync(resolve(root, sourcePath), 'utf8');
  const splitSources = readdirSync(resolve(root, splitSourceDir))
    .filter((entry) => entry.endsWith('.rs'))
    .sort()
    .map((entry) => readFileSync(resolve(root, join(splitSourceDir, entry)), 'utf8'))
    .join('\n');
  return `${rootSource}\n${splitSources}`;
}
const source = readRelayResponseSourceSurface();

function fail(message) {
  console.error(`[verify:v3-relay-response-semantics] ${message}`);
  process.exit(1);
}

function functionBody(name) {
  const marker = `fn ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) fail(`missing owner function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  fail(`unterminated owner function ${name}`);
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

const normalize = functionBody('normalize_v3_hub_relay_response');
const providerRespCompat = [
  functionBody('build_provider_resp_compat_02_from_v3_provider_resp_inbound_01'),
  functionBody('apply_v3_provider_resp_compat'),
].join('\n');
const govern = functionBody('govern_v3_hub_relay_response');
const resp03ProtocolGovernance = [
  govern,
  functionBody('build_v3_resp03_protocol_governance'),
  functionBody('build_v3_responses_resp03_protocol_governance'),
  functionBody('collect_v3_resp03_responses_tool_calls'),
  functionBody('build_v3_openai_chat_resp03_protocol_governance'),
  functionBody('build_v3_gemini_resp03_protocol_governance'),
].join('\n');
const commit = functionBody('commit_v3_hub_relay_response');
const resp05 = functionBody('build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04');
const resp06 = functionBody('build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05');
const responseExit = functionBody('response_exit_node');

requireAll(normalize, 'Resp02 normalize', [
  'V3HubExecutionMode::Relay',
  'ProviderResponseNotObject',
  'build_provider_resp_compat_02_from_v3_provider_resp_inbound_01',
  'build_v3_hub_resp_inbound_02_from_provider_resp_compat_02',
]);
forbidAll(normalize, 'Resp02 normalize', [
  /tool_calls/,
  /servertool_names/,
  /terminality/,
  /canonical_context/,
  /Arc::clone/,
]);

requireAll(providerRespCompat, 'ProviderRespCompat02 provider-private only', [
  'run_resp_inbound_stage3_compat',
  'ReqOutboundCompatInput',
  'AdapterContext',
  'provider_protocol_compat_id',
]);
forbidAll(providerRespCompat, 'ProviderRespCompat02 provider-private only', [
  /tool_search/,
  /exec_command/,
  /Script running/,
  /unsupported Responses tool type/,
  /tool_calls/,
  /servertool_names/,
  /V3HubContinuationCommit/,
  /V3HubRelayResponseHookProfile/,
  /build_v3_resp03_protocol_governance/,
]);

requireAll(resp03ProtocolGovernance, 'Resp03 Chat Process', [
  '"function_call"',
  '"custom_tool_call"',
  '"tool_call"',
  'MalformedToolCall',
  'MissingStatus',
  'UnsupportedStatus',
  'V3HubResponseTerminality::NonTerminal',
  'V3HubServertoolResponseAction::FollowupRequired',
]);
forbidAll(resp03ProtocolGovernance, 'Resp03 Chat Process', [
  /canonical_context/,
  /V3HubContinuationCommit/,
  /Arc::clone/,
  /V3ServerRespOutbound06ClientFrame/,
  /provider[_-]?family/i,
  /unwrap_or\("completed"\)/,
]);

requireAll(commit, 'Resp04 continuation commit', [
  'V3HubResponseTerminality::Terminal',
  'V3HubResponseTerminality::NonTerminal',
  'V3HubContinuationCommit::LocalContext',
  'V3HubRelayCanonicalResponseContext',
  'Arc::clone',
]);
if ((commit.match(/Arc::clone/g) ?? []).length !== 1) {
  fail('Resp04 continuation commit: canonical payload must use exactly one Arc::clone');
}
forbidAll(commit, 'Resp04 continuation commit', [
  /serde_json::(?:to_vec|to_string|from_slice|from_str)/,
  /payload\.clone\s*\(/,
  /Value::clone/,
  /V3ServerRespOutbound06ClientFrame/,
]);

forbidAll(`${resp05}\n${resp06}`, 'Resp05/Server immutable interval', [
  /canonical_context\s*:/,
  /Arc::clone/,
  /tool_calls\s*:/,
  /servertool_action\s*:/,
  /required_action/,
  /serde_json::(?:to_vec|to_string|from_slice|from_str)/,
]);

requireAll(source, sourcePath, [
  'pub fn compile_v3_hub_relay_response_hooks()',
  'normalize: normalize_v3_hub_relay_response',
  'govern: govern_v3_hub_relay_response',
  'commit: commit_v3_hub_relay_response',
  '"V3ServerRespOutbound06ClientFrame"',
]);
requireAll(responseExit, 'single response exit', ['"V3ServerRespOutbound06ClientFrame"']);
forbidAll(source, sourcePath, [
  /dynamic[_-]?hook/i,
  /fallback/i,
  /provider[_-]?family/i,
]);
forbidAll(responseExit, 'single response exit', [/serde_json::(?:to_vec|to_string|from_slice|from_str)/]);

function filesBelow(relative) {
  const absolute = resolve(root, relative);
  const files = [];
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) files.push(...filesBelow(join(relative, entry)));
    else if (entry.endsWith('.rs')) files.push(path);
  }
  return files;
}

const forbiddenOwners = [
  ...filesBelow('v3/crates/routecodex-v3-server/src'),
  ...filesBelow('v3/crates/routecodex-v3-provider-responses/src'),
];
for (const path of forbiddenOwners) {
  const text = readFileSync(path, 'utf8');
  if (/compile_v3_hub_relay_response_hooks|V3HubRelayCanonicalResponseContext/.test(text)) {
    fail(`${path.slice(root.length + 1)}: Relay response semantics escaped Hub Resp01-Resp04 owner`);
  }
}

console.log('[verify:v3-relay-response-semantics] ok');
