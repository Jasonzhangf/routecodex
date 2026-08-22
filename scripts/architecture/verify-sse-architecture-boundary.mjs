import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
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
      } else if (/\.(rs|ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

// V3 SSE transport must remain protocol-neutral: it frames/decodes SSE without
// interpreting event names or payload semantics.
const v3SseCrate = 'v3/crates/routecodex-v3-sse/src/lib.rs';
const v3Sse = read(v3SseCrate);
for (const required of [
  'Protocol-neutral incremental SSE framing',
  'does not interpret event names',
  'SseTransportLimits',
  'SseTransportError',
]) {
  if (!v3Sse.includes(required)) {
    failures.push(`${v3SseCrate}: missing V3 protocol-neutral SSE marker ${required}`);
  }
}
for (const forbidden of [
  'response.created',
  'output_item',
  'message_start',
  'message_stop',
  'function_call',
  'tool_use',
  'finish_reason',
  'required_action',
  'chat.completion',
]) {
  if (v3Sse.includes(forbidden)) {
    failures.push(`${v3SseCrate}: V3 SSE transport must not interpret business event semantics: ${forbidden}`);
  }
}

const deletedNativeBridgePath = 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.ts';
if (fs.existsSync(path.join(root, deletedNativeBridgePath))) {
  failures.push(`${deletedNativeBridgePath}: retired SSE native TS wrapper must stay physically deleted`);
}

// Server websocket projection may forward JSON data, but it must not synthesize
// JSON business type/status from the opaque SSE event field.
const websocketProjectionPath = 'v3/crates/routecodex-v3-server/src/websocket.rs';
const websocketProjection = read(websocketProjectionPath);
for (const forbidden of ['event_name', 'response.event']) {
  if (websocketProjection.includes(forbidden)) {
    failures.push(`${websocketProjectionPath}: must not reconstruct JSON semantics from SSE event metadata: ${forbidden}`);
  }
}

// TS runtime roots must not import retired TS SSE wrapper paths.
for (const runtimeRoot of [
  'sharedmodule/llmswitch-core/src/conversion/hub',
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
console.log('- V3 SSE transport is protocol-neutral (routecodex-v3-sse)');
console.log('- runtime roots do not import TS SSE wrapper paths');
