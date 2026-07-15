#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const hubPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs';
const requestPath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs';
const hub = readFileSync(resolve(root, hubPath), 'utf8');
const request = readFileSync(resolve(root, requestPath), 'utf8');

function fail(message) {
  console.error(`[verify:v3-relay-request-semantics] ${message}`);
  process.exit(1);
}

function functionBody(source, name) {
  const marker = name.startsWith('pub ') || name.startsWith('fn ') ? name : `fn ${name}`;
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
  for (const phrase of phrases) if (!text.includes(phrase)) fail(`${owner}: missing ${phrase}`);
}

function forbidAll(text, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(text)) fail(`${owner}: forbidden ${pattern}`);
}

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

const req02 = functionBody(hub, 'pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01');
const req03 = functionBody(request, 'fn classify_continuation');
const req04 = functionBody(request, 'fn run_from_normalized_with_events');
const restore = functionBody(request, 'fn restore_local_context_at_req04');
const servertool = functionBody(request, 'fn run_servertool_profile');

requireAll(req02, 'Req02 lossless Chat normalization', [
  'V3HubRequestSemanticProtocol::Chat',
  'previous: input',
]);
forbidAll(req02, 'Req02 lossless Chat normalization', [
  /serde_json::(?:to_value|from_value|to_string|from_str|to_vec|from_slice)/,
  /\.clone\s*\(/,
  /restore/i,
  /servertool/i,
]);

requireAll(req03, 'Req03 continuation classification', [
  'V3HubContinuationOwnership::New',
  'V3HubContinuationOwnership::RemoteProviderOwned',
  'V3HubContinuationOwnership::RouteCodexLocalOwned',
  'ContinuationScopeMismatch',
]);
forbidAll(req03, 'Req03 continuation classification', [
  /Arc::clone/,
  /canonical_context/,
  /restore/i,
  /servertool/i,
  /govern_tool_outputs/,
  /build_v3_hub_req_chat_process_04/,
]);

requireAll(req04, 'Req04 Chat Process governance', [
  'restore_local_context_at_req04',
  'govern_tool_outputs',
  'run_servertool_profile',
  'Req04Entry',
  'Req04Exit',
  'build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03',
]);
if (req04.indexOf('restore_local_context_at_req04') > req04.indexOf('run_servertool_profile')) {
  fail('Req04 Chat Process governance: servertool ran before local continuation restore');
}
forbidAll(req04, 'Req04 Chat Process governance', [
  /build_v3_hub_req_execution_05/,
  /V3HubReqExecution05Planned/,
  /provider[_-]?family/i,
  /model_prefix|starts_with\(/,
]);

requireAll(restore, 'Req04 local restore', [
  'V3HubContinuationOwnership::RouteCodexLocalOwned',
  'Arc::clone(&local.canonical_context)',
  'LocalContextMissingAtRestore',
]);
if ((restore.match(/Arc::clone/g) ?? []).length !== 1) fail('Req04 local restore must use exactly one Arc clone of canonical context');
forbidAll(restore, 'Req04 local restore', [
  /serde_json::(?:to_value|from_value|to_string|from_str|to_vec|from_slice)/,
  /payload\.clone\s*\(/,
  /Value::clone/,
]);

requireAll(servertool, 'Req04 static servertool hook profile', [
  'servertool.request',
  'ServertoolOptionalNoop',
  'RequiredHookFailed',
  'UnknownStaticHook',
]);

forbidAll(request, requestPath, [
  /std::fs|libloading|discover.*hook|dynamic.*hook/i,
  /fallback/i,
  /provider[_-]?family/i,
  /serde_json::(?:to_value|from_value|to_string|from_str|to_vec|from_slice)/,
  /payload\.clone\s*\(/,
]);

requireAll(request, requestPath, [
  'pub fn compile_v3_hub_relay_request_hooks()',
  'pub fn run(',
  'pub fn run_from_normalized(',
  'self.run_from_normalized_with_events(',
  'V3HubRelayRequestHookEvent::Req01Entry',
  'V3HubRelayRequestHookEvent::Req01Exit',
  'V3HubRelayRequestHookEvent::Req02Entry',
  'V3HubRelayRequestHookEvent::Req02Exit',
  'V3HubRelayRequestHookEvent::Req03Entry',
  'V3HubRelayRequestHookEvent::Req03Exit',
  'V3HubRelayRequestHookEvent::Req04Entry',
  'V3HubRelayRequestHookEvent::Req04Exit',
]);

for (const path of [
  ...filesBelow('v3/crates/routecodex-v3-server/src'),
  ...filesBelow('v3/crates/routecodex-v3-provider-responses/src'),
]) {
  const text = readFileSync(path, 'utf8');
  if (/compile_v3_hub_relay_request_hooks|V3HubRelayRequestHooks|V3HubContinuationLookup/.test(text)) {
    fail(`${path.slice(root.length + 1)}: Relay request semantics escaped Hub Req01-Req04 owner`);
  }
}

console.log('[verify:v3-relay-request-semantics] ok');
