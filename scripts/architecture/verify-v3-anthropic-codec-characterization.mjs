#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs';
const source = readFileSync(resolve(root, sourcePath), 'utf8');
const tests = readFileSync(resolve(root, 'v3/crates/routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs'), 'utf8');
const failures = [];

function fail(message) { failures.push(message); }
function requireAll(text, owner, phrases) {
  for (const phrase of phrases) if (!text.includes(phrase)) fail(owner + ': missing ' + phrase);
}
function forbidAll(text, owner, patterns) {
  for (const pattern of patterns) if (pattern.test(text)) fail(owner + ': forbidden ' + pattern);
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

requireAll(source, sourcePath, [
  'V3AnthropicCodecStage', 'ClientInputToHubSemantic', 'HubSemanticToProviderWire',
  'ProviderRawToHubResponseSemantic', 'HubResponseSemanticToClientProjection',
  'V3HubEntryProtocol::Anthropic', 'V3HubProviderWireProtocol::Anthropic',
  'validate_json_response', 'validate_sse_event', 'reject_side_channel_fields', 'into_object',
  'routecodex_internal', 'metadata_center', 'debug_snapshot', 'provider_protocol',
  'resource_handle', 'MalformedProviderError',
  'MalformedSseEvent',
]);
forbidAll(source, sourcePath, [
  /compile_v3_hub_v1_static_registry/, /compile_v3_hub_relay_(?:request|response)_hooks/,
  /V3HubStaticHookRegistry/, /V3HubRelay(?:Request|Response)Hook/, /routecodex-v3-server/,
  /Gemini/, /OpenAiChat/, /fallback/i, /provider[_-]?family/i,
  /metadata_center[\s\S]{0,120}payload\s*:/,
  /object_clone_without_internal_fields/, /value\.clone\s*\(/,
]);
requireAll(tests, 'focused Anthropic codec tests', [
  'tool_result', 'tool_use', 'thinking', 'V3HubTransportIntent::Sse',
  'MalformedProviderError', 'MalformedSseEvent', 'SideChannelLeaked', 'ProviderProtocolNotAnthropic',
]);

for (const path of [
  ...filesBelow('v3/crates/routecodex-v3-server/src'),
  ...filesBelow('v3/crates/routecodex-v3-provider-responses/src'),
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
]) {
  const text = readFileSync(resolve(root, path), 'utf8');
  if (/V3AnthropicCodecStage|characterize_v3_anthropic|hub_anthropic_codec_characterization/.test(text)) {
    fail(path + ': Anthropic codec characterization must not register hooks or runtime wiring');
  }
}

const maps = [
  ['docs/architecture/v3-function-map.yml', readFileSync(resolve(root, 'docs/architecture/v3-function-map.yml'), 'utf8')],
  ['docs/architecture/v3-verification-map.yml', readFileSync(resolve(root, 'docs/architecture/v3-verification-map.yml'), 'utf8')],
  ['docs/architecture/v3-mainline-call-map.yml', readFileSync(resolve(root, 'docs/architecture/v3-mainline-call-map.yml'), 'utf8')],
];
for (const [file, text] of maps) requireAll(text, file, [
  'v3.protocol_anthropic_codec_characterization', 'v3-protocol-anthropic-01',
  'v3-protocol-anthropic-02', 'v3-protocol-anthropic-03', 'v3-protocol-anthropic-04',
]);
requireAll(readFileSync(resolve(root, 'docs/architecture/v3-resource-operation-map.yml'), 'utf8'), 'resource map', [
  'v3.hub.provider_protocol', 'v3.hub.provider_wire_payload',
  'v3.hub.response_semantic', 'v3.response.client_payload',
]);

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const script of ['test:v3-anthropic-codec-characterization', 'verify:v3-anthropic-codec-characterization', 'test:v3-anthropic-codec-characterization-red-fixtures']) {
  if (!packageJson.scripts?.[script]) fail('package.json: missing script ' + script);
}
if (failures.length) {
  console.error('[verify:v3-anthropic-codec-characterization] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-anthropic-codec-characterization] ok');
