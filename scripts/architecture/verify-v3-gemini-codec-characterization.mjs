#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourcePath = 'v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_codec.rs';
const source = readFileSync(resolve(root, sourcePath), 'utf8');
const tests = readFileSync(resolve(root, 'v3/crates/routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs'), 'utf8');
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
  'V3GeminiCodecStage', 'ClientInputToHubSemantic', 'HubSemanticToProviderWire',
  'ProviderRawToHubResponseSemantic', 'HubResponseSemanticToClientProjection',
  'V3HubEntryProtocol::Gemini', 'V3HubProviderWireProtocol::Gemini',
  'validate_contents', 'validate_response', 'reject_side_channel_fields',
  'InvalidFunctionResponseIdentity', 'MalformedProviderError', 'CandidatesNotArray',
  'routecodex_internal', 'metadata_center', 'debug_snapshot', 'provider_protocol',
  'resource_handle', 'continuation_owner',
]);
forbidAll(source, sourcePath, [
  /compile_v3_hub_v1_static_registry/, /compile_v3_hub_relay_(?:request|response)_hooks/,
  /V3HubStaticHookRegistry/, /V3HubRelay(?:Request|Response)Hook/, /routecodex-v3-server/,
  /V3HubEntryProtocol::(?:Responses|Anthropic|OpenAiChat)/, /fallback/i, /materializ/i,
  /metadata_center[\s\S]{0,120}payload\s*:/, /value\.clone\s*\(/,
]);
requireAll(tests, 'focused Gemini codec tests', [
  'functionResponse', 'orphan', 'finishReason', 'usageMetadata', 'V3HubTransportIntent::Sse',
  'MalformedProviderError', 'SideChannelLeaked', 'ProviderProtocolNotGemini',
]);
for (const path of [
  ...filesBelow('v3/crates/routecodex-v3-server/src'),
  ...filesBelow('v3/crates/routecodex-v3-provider-responses/src'),
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
]) {
  const text = readFileSync(resolve(root, path), 'utf8');
  if (/V3GeminiCodecStage|characterize_v3_gemini/.test(text)) fail(`${path}: characterization must not register runtime wiring`);
}
for (const file of ['docs/architecture/v3-function-map.yml', 'docs/architecture/v3-verification-map.yml', 'docs/architecture/v3-mainline-call-map.yml']) {
  requireAll(readFileSync(resolve(root, file), 'utf8'), file, [
    'v3.protocol_gemini_codec_characterization', 'v3-protocol-gemini-01',
    'v3-protocol-gemini-02', 'v3-protocol-gemini-03', 'v3-protocol-gemini-04',
  ]);
}
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
for (const script of ['test:v3-gemini-codec-characterization', 'verify:v3-gemini-codec-characterization', 'test:v3-gemini-codec-characterization-red-fixtures']) {
  if (!scripts[script]) fail(`package.json: missing script ${script}`);
}
if (failures.length) {
  console.error('[verify:v3-gemini-codec-characterization] failed');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('[verify:v3-gemini-codec-characterization] ok');
