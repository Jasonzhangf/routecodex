#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const failures = [];
const runtimeFiles = [
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'v3/crates/routecodex-v3-runtime/src/hooks.rs',
  'v3/crates/routecodex-v3-runtime/src/nodes.rs',
];
const runtimeSource = runtimeFiles.map((path) => read(path)).join('\n');
const runtime = runtimeFiles
  .map((path) => read(path).replace(/#\[cfg\(test\)\][\s\S]*/, ''))
  .join('\n');
const runtimePolicySurface = runtimeFiles
  .slice(0, 2)
  .map((path) => read(path).replace(/#\[cfg\(test\)\][\s\S]*/, ''))
  .join('\n');
const topologySources = [
  runtimeSource,
  read('v3/crates/routecodex-v3-virtual-router/src/lib.rs'),
  read('v3/crates/routecodex-v3-target/src/lib.rs'),
  read('v3/crates/routecodex-v3-provider-responses/src/wire.rs'),
  read('v3/crates/routecodex-v3-provider-responses/src/transport.rs'),
  read('v3/crates/routecodex-v3-provider-responses/src/raw_response.rs'),
].join('\n');
const server = [
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/direct_frame.rs',
  'v3/crates/routecodex-v3-server/src/endpoints.rs',
].map((path) => read(path).replace(/#\[cfg\(test\)\][\s\S]*/, '')).join('\n');
const kernel = read(runtimeFiles[0]);

const requiredP6Nodes = [
  'V3Server03HttpRequestRaw',
  'V3Req04StandardizedResponses',
  'V3Router05RequestClassified',
  'V3Router06RoutePoolResolved',
  'V3Router07OpaqueTargetHitOnce',
  'V3Target08KindClassified',
  'V3Target09CandidateSetExpanded',
  'V3Target10ConcreteProviderSelected',
  'V3ResponsesDirect11Policy',
  'V3Provider12ResponsesWirePayload',
  'V3Transport13ResponsesHttpRequest',
  'V3ProviderResp14Raw',
  'V3DirectResp14ProviderProjectionPrepared',
  'V3DirectResp15ClientPayloadReady',
  'V3Resp15ClientPayload',
];
for (const node of requiredP6Nodes) {
  if (!topologySources.includes(`"${node}"`) && !topologySources.includes(`struct ${node}`) && !topologySources.includes(`type ${node}`)) {
    failures.push(`P6 frozen topology missing ${node}`);
  }
}

for (const [label, pattern] of [
  ['Chat Process expansion', /ChatProcess|chat_process/i],
  ['Relay expansion', /\bRelay\b|relay_/i],
  ['other entry protocol expansion', /Anthropic|Gemini|OpenAiChat|chat_completions|\/v1\/messages/i],
  ['provider identity/family/model-prefix branch', /provider_(?:id|family)\s*(?:==|!=)|starts_with\([^)]*model|match\s+provider_(?:id|family)/i],
  ['same-protocol Direct inference', /same_protocol|protocol\s*==\s*[^;\n]*direct/i],
  ['fallback behavior', /fallback|unwrap_or_else\([^)]*execute_v3_responses_direct/i],
  ['dynamic hook behavior', /libloading|discover.*hook|dynamic.*hook|std::fs.*hook/i],
]) {
  if (pattern.test(runtimePolicySurface)) failures.push(`P6 freeze forbids ${label}`);
}

const lifecycleExecutors = [...kernel.matchAll(/pub\s+async\s+fn\s+(execute_v3_[a-z0-9_]*responses_direct[a-z0-9_]*)/g)]
  .map((match) => match[1]);
const allowedExecutors = new Set([
  'execute_v3_responses_direct_dry_run_runtime',
  'execute_v3_responses_direct_runtime_kernel',
]);
for (const executor of lifecycleExecutors) {
  if (!allowedExecutors.has(executor)) failures.push(`P6 freeze forbids second lifecycle executor ${executor}`);
}

const directBranchStart = server.indexOf('if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {');
const directBranchEnd = directBranchStart < 0 ? -1 : server.indexOf('} else if execution_mode == V3EntryProtocolExecutionMode::PendingNotImplemented', directBranchStart);
const directBranch = directBranchStart >= 0 && directBranchEnd > directBranchStart
  ? server.slice(directBranchStart, directBranchEnd)
  : '';
const frameFunctionStart = server.indexOf('async fn execute_responses_direct_server_frame(');
const frameFunctionEnd = frameFunctionStart < 0 ? -1 : server.indexOf('\nstruct V3DirectSseConsoleCloseoutStream', frameFunctionStart);
const frameFunction = frameFunctionStart >= 0 && frameFunctionEnd > frameFunctionStart
  ? server.slice(frameFunctionStart, frameFunctionEnd)
  : '';
const responsesBranch = `${directBranch}\n${frameFunction}`;
if (!frameFunction.includes('execute_v3_responses_direct_runtime_kernel(')) {
  failures.push('P6 Server entry no longer calls the frozen Runtime kernel');
}
if ((frameFunction.match(/build_v3_server_16_http_frame_from_v3_resp_15/g) ?? []).length !== 1) {
  failures.push('P6 must have exactly one response frame builder');
}
if ((directBranch.match(/responses_direct_output_response_with_console\(/g) ?? []).length !== 1) {
  failures.push('P6 must have exactly one response exit');
}
if (/routecodex_v3_provider_responses|\.send\(/.test(responsesBranch)) {
  failures.push('P6 Server shortcut to Provider transport is forbidden');
}
if (/provider_(?:id|family)\s*(?:==|!=)|model_prefix|starts_with\(|\bRelay\b|ChatProcess/i.test(responsesBranch)) {
  failures.push('P6 Server entry contains forbidden branch expansion');
}
if (/secondary_response_exit|alternate_response_exit|second_response_exit/.test(server)) {
  failures.push('P6 second response exit is forbidden');
}

if (failures.length) {
  console.error('[verify:v3-p6-freeze] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-p6-freeze] ok');
