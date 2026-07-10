import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const functionMap = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');
const verificationMap = fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8');

const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function listFiles(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'target') continue;
        stack.push(next);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

for (const featureId of [
  'sse.runtime_rust_dispatch',
  'sse.stream_parse_boundary',
  'sse.event_type_validation',
  'sse.chat_stream_projection',
  'sse.responses_encode_projection',
  'sse.responses_decode_projection',
  'sse.anthropic_gemini_stream_projection',
]) {
  const marker = `feature_id: ${featureId}`;
  if (!functionMap.includes(marker)) failures.push(`function-map missing ${marker}`);
  if (!verificationMap.includes(marker)) failures.push(`verification-map missing ${marker}`);
}

const rustDispatchPath = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/sse_runtime_dispatch.rs';
const rustDispatch = read(rustDispatchPath);
for (const required of [
  'feature_id: sse.runtime_rust_dispatch',
  'pub fn build_sse_frames_from_json_json',
  'pub fn build_json_from_sse_json',
  'fn normalize_protocol',
  '"openai-chat"',
  '"openai-responses"',
  '"anthropic-messages"',
  '"gemini-chat"',
  'Unsupported SSE protocol',
]) {
  if (!rustDispatch.includes(required)) {
    failures.push(`${rustDispatchPath}: missing Rust runtime dispatch marker ${required}`);
  }
}
for (const forbidden of [
  'unwrap_or("openai-chat")',
  'unwrap_or("openai-responses")',
  'unwrap_or("responses")',
  'unwrap_or("chat")',
  'unknown" => Ok',
]) {
  if (rustDispatch.includes(forbidden)) {
    failures.push(`${rustDispatchPath}: Rust SSE dispatch must not default/fallback protocol: ${forbidden}`);
  }
}

const deletedNativeBridgePath = 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.ts';
if (fs.existsSync(path.join(root, deletedNativeBridgePath))) {
  failures.push(`${deletedNativeBridgePath}: retired SSE native TS wrapper must stay physically deleted`);
}

for (const [ownerPath, requiredMarkers] of [
  ['src/modules/llmswitch/bridge/provider-response-converter-host.ts', [
    'getRouterHotpathJsonBindingSync',
    'buildSseFramesFromJsonJson',
    'buildReadableFromSseFrames',
  ]],
  ['src/modules/llmswitch/bridge/runtime-integrations.ts', [
    'getRouterHotpathJsonBindingSync',
    'buildJsonFromSseJson',
    'collectSseBodyText',
  ]],
  ['scripts/helpers/sse-direct-native.mjs', [
    'router_hotpath_napi.node',
    'buildSseFramesFromJsonJson',
    'buildJsonFromSseJson',
  ]],
  ['tests/sharedmodule/helpers/sse-direct-native.ts', [
    'router_hotpath_napi.node',
    'buildSseFramesFromJsonJson',
    'buildJsonFromSseJson',
  ]],
]) {
  const source = read(ownerPath);
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) {
      failures.push(`${ownerPath}: missing direct native SSE marker ${marker}`);
    }
  }
}

const lib = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs');
for (const required of [
  'mod sse_runtime_dispatch;',
  'buildJsonFromSseJson',
  'buildSseFramesFromJsonJson',
]) {
  if (!lib.includes(required)) failures.push(`router-hotpath lib.rs missing ${required}`);
}

const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts');
for (const required of [
  '"buildSseFramesFromJsonJson"',
  '"buildJsonFromSseJson"',
]) {
  if (!requiredExports.includes(required)) {
    failures.push(`native required exports missing ${required}`);
  }
}

for (const runtimeRoot of [
  'sharedmodule/llmswitch-core/src/conversion/hub',
  'src/server',
  'sharedmodule/llmswitch-core/src/runtime',
  'sharedmodule/llmswitch-core/src/servertool',
]) {
  for (const file of listFiles(runtimeRoot)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    for (const forbidden of [
      'sse/json-to-sse',
      'sse/sse-to-json',
      'sse/registry',
      'sse/index.js',
      'defaultSseCodecRegistry',
      'new ChatJsonToSseConverter',
      'new ResponsesJsonToSseConverter',
      'new AnthropicJsonToSseConverter',
      'new GeminiJsonToSseConverter',
      'new ChatSseToJsonConverter',
      'new ResponsesSseToJsonConverter',
      'new AnthropicSseToJsonConverter',
      'new GeminiSseToJsonConverter',
    ]) {
      if (source.includes(forbidden)) {
        failures.push(`${rel}: runtime must not import/use TS SSE runtime wrapper: ${forbidden}`);
      }
    }
  }
}

const sseIndexPath = 'sharedmodule/llmswitch-core/src/sse/index.ts';
if (fs.existsSync(path.join(root, sseIndexPath))) {
  const sseIndex = read(sseIndexPath);
  for (const forbidden of [
    'defaultSseCodecRegistry',
    'createChatConverters(',
    'createResponsesConverters(',
    'createAnthropicConverters(',
    'createGeminiConverters(',
    'async roundTrip(',
  ]) {
    if (sseIndex.includes(forbidden)) {
      failures.push(`${sseIndexPath}: public SSE lib must not expose registry/factory runtime semantics: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:sse-architecture-boundary] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:sse-architecture-boundary] ok');
console.log('- SSE runtime dispatch is Rust-owned');
console.log('- runtime roots do not import TS SSE wrapper paths');
