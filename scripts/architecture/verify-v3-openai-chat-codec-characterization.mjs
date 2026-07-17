#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs';
const source = readFileSync(resolve(root, sourcePath), 'utf8');
const tests = readFileSync(resolve(root, 'v3/crates/routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs'), 'utf8');
const failures = [];
const fail = message => failures.push(message);
const requireAll = (text, owner, phrases) => phrases.forEach(phrase => { if (!text.includes(phrase)) fail(`${owner}: missing ${phrase}`); });
const forbidAll = (text, owner, patterns) => patterns.forEach(pattern => { if (pattern.test(text)) fail(`${owner}: forbidden ${pattern}`); });
function filesBelow(relative) {
  const files = [];
  for (const entry of readdirSync(resolve(root, relative))) {
    const path = join(relative, entry);
    if (statSync(resolve(root, path)).isDirectory()) files.push(...filesBelow(path));
    else if (entry.endsWith('.rs')) files.push(path);
  }
  return files;
}

requireAll(source, sourcePath, [
  'V3OpenAiChatCodecStage', 'ClientInputToHubSemantic', 'HubSemanticToProviderWire',
  'ProviderRawToHubResponseSemantic', 'HubResponseSemanticToClientProjection',
  'V3HubEntryProtocol::OpenAiChat', 'V3HubProviderWireProtocol::OpenAiChat',
  'MessagesNotArray', 'validate_sse_event', 'reject_side_channel_fields',
  'MalformedProviderError', 'MalformedSseEvent',
  'routecodex_internal', 'metadata_center', 'debug_snapshot', 'provider_protocol',
  'resource_handle', 'continuation_owner',
]);
forbidAll(source, sourcePath, [
  /compile_v3_hub_v1_static_registry/, /compile_v3_hub_relay_(?:request|response)_hooks/,
  /V3HubStaticHookRegistry/, /V3HubRelay(?:Request|Response)Hook/, /routecodex-v3-server/,
  /V3HubEntryProtocol::(?:Responses|Anthropic|Gemini)/, /fallback/i, /materializ/i,
  /metadata_center[\s\S]{0,120}payload\s*:/, /value\.clone\s*\(/,
  /validate_message_tool_identity/, /InvalidToolCallIdentity/, /\bBTreeSet\b/,
]);
requireAll(tests, 'focused OpenAI Chat codec tests', [
  'multiple_tool_calls', 'not_normalization', 'finish_reason', 'V3HubTransportIntent::Sse',
  'MalformedProviderError', 'SideChannelLeaked', 'ProviderProtocolNotOpenAiChat',
]);
for (const path of [
  ...filesBelow('v3/crates/routecodex-v3-server/src'),
  ...filesBelow('v3/crates/routecodex-v3-provider-responses/src'),
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
]) {
  const text = readFileSync(resolve(root, path), 'utf8');
  if (/V3OpenAiChatCodecStage|characterize_v3_openai_chat/.test(text)) fail(`${path}: characterization must not register runtime wiring`);
}
for (const file of ['docs/architecture/v3-function-map.yml', 'docs/architecture/v3-verification-map.yml', 'docs/architecture/v3-mainline-call-map.yml']) {
  requireAll(readFileSync(resolve(root, file), 'utf8'), file, [
    'v3.protocol_openai_chat_codec_characterization', 'v3-protocol-openai-chat-01',
    'v3-protocol-openai-chat-02', 'v3-protocol-openai-chat-03', 'v3-protocol-openai-chat-04',
  ]);
}
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
for (const script of ['test:v3-openai-chat-codec-characterization', 'verify:v3-openai-chat-codec-characterization', 'test:v3-openai-chat-codec-characterization-red-fixtures']) {
  if (!scripts[script]) fail(`package.json: missing script ${script}`);
}
if (failures.length) {
  console.error('[verify:v3-openai-chat-codec-characterization] failed');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[verify:v3-openai-chat-codec-characterization] ok');
