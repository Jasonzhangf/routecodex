import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sseRoot = path.join(root, 'sharedmodule/llmswitch-core/src/sse');
const functionMap = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');
const verificationMap = fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8');

const requiredFeatures = [
  'sse.codec_registry_surface',
  'sse.stream_parse_boundary',
  'sse.responses_decode_projection',
  'sse.responses_encode_projection',
  'sse.chat_stream_projection',
  'sse.anthropic_gemini_stream_projection',
];

const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules') continue;
        stack.push(next);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

for (const featureId of requiredFeatures) {
  const marker = `feature_id: ${featureId}`;
  if (!functionMap.includes(marker)) failures.push(`function-map missing ${marker}`);
  if (!verificationMap.includes(marker)) failures.push(`verification-map missing ${marker}`);
}

const sourceFiles = listFiles(sseRoot);
const sourceByRel = new Map(
  sourceFiles.map((file) => [path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')])
);

for (const featureId of requiredFeatures) {
  const anchor = `feature_id: ${featureId}`;
  const hits = [...sourceByRel.entries()].filter(([, source]) => source.includes(anchor));
  if (hits.length === 0) failures.push(`SSE source anchor missing for ${featureId}`);
}

const registry = read('sharedmodule/llmswitch-core/src/sse/registry/sse-codec-registry.ts');
for (const forbidden of [
  'export type SseStreamLike = any',
  'export type SseStreamInput = any',
  "return 'unknown'",
  "?? 'unknown'",
  'fallback?: string',
]) {
  if (registry.includes(forbidden)) {
    failures.push(`SSE registry must not expose any stream alias: ${forbidden}`);
  }
}

const writer = read('sharedmodule/llmswitch-core/src/sse/shared/writer.ts');
for (const forbidden of [
  'ignore and fallback',
  'response.unknown',
  '临时实现',
  '仅用于避免编译错误',
  'this.config.onError(error as Error);\n    }\n  }\n\n  /**\n   * 处理背压',
  'this.config.onError(error as Error);\n    }\n  }\n\n  /**\n   * 同步写入事件数组',
]) {
  if (writer.includes(forbidden)) {
    failures.push(`SSE writer retains fallback serializer marker: ${forbidden}`);
  }
}

const responsesSerializer = read('sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts');
for (const forbidden of [
  'eventData = dataStr;',
  'if (!source) return Date.now();',
  'return Number.isNaN(parsed) ? Date.now() : parsed;',
]) {
  if (responsesSerializer.includes(forbidden)) {
    failures.push(`Responses SSE serializer retains parse salvage marker: ${forbidden}`);
  }
}

const sharedOwnerFiles = [
  'sharedmodule/llmswitch-core/src/sse/registry/sse-codec-registry.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/writer.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/utils.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts',
];

for (const relPath of sharedOwnerFiles) {
  const source = read(relPath);
  for (const providerSpecific of ['deepseek', 'glm', 'lmstudio', 'minimax', 'qwen', 'kimi', 'siliconflow']) {
    if (source.toLowerCase().includes(providerSpecific)) {
      failures.push(`${relPath}: shared SSE owner must not contain provider-specific branch marker "${providerSpecific}"`);
    }
  }
}

const sharedUtils = read('sharedmodule/llmswitch-core/src/sse/shared/utils.ts');
for (const forbidden of [
  'safeStringify',
  'safeParse',
  'isValidJson',
  'static truncate',
  'static random',
  'export class ValidationUtils',
  'export class IdUtils',
  'isTimeoutError',
  'isNetworkError',
]) {
  if (sharedUtils.includes(forbidden)) {
    failures.push(`SSE shared utils resurrects dead fallback/helper wrapper: ${forbidden}`);
  }
}

const anthropicResponseBuilder = read('sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/anthropic-response-builder.ts');
for (const forbidden of [
  'state.id || `msg_${Date.now()}`',
  "state.role || 'assistant'",
  "state.model || 'unknown'",
]) {
  if (anthropicResponseBuilder.includes(forbidden)) {
    failures.push(`Anthropic SSE builder resurrects message fallback: ${forbidden}`);
  }
}

const providerNeutralProjectionFiles = [
  'sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts',
  'sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/response-builder.ts',
  'sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts',
  'sharedmodule/llmswitch-core/src/sse/sse-to-json/gemini-sse-to-json-converter.ts',
  'sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/chat.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/chat-sequencer.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts',
  'sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts',
];

for (const relPath of providerNeutralProjectionFiles) {
  const source = read(relPath);
  for (const providerSpecific of ['deepseek', 'glm', 'lmstudio', 'minimax', 'qwen', 'kimi', 'siliconflow']) {
    if (source.toLowerCase().includes(providerSpecific)) {
      failures.push(`${relPath}: provider-neutral SSE projection must not contain provider-specific marker "${providerSpecific}"`);
    }
  }
  for (const forbidden of [
    'tryMaterializeFinalResponse',
    'getSalvageResult',
    'const salvaged =',
    'return salvaged',
    'const fallback = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }',
    "args = '{}'",
    "fallback = 'model'",
    "return String(input ?? '')",
    'response.id || `msg_${requestId}`',
    "response.role || 'assistant'",
    'block.id || `call_${requestId}_${index}`',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath}: provider-neutral SSE projection must not salvage partial streams into successful responses: ${forbidden}`);
    }
  }
}

const forbiddenFrameKeys = [
  'metadata',
  '__rt',
  'runtimeMetadata',
  'metaCarrier',
  'errorCarrier',
  'snapshot',
  'debug',
];

for (const [relPath, source] of sourceByRel.entries()) {
  if (!relPath.includes('/json-to-sse/') && !relPath.includes('/shared/')) continue;
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (!/data:\s*\$?\{?|JSON\.stringify|payload\.|frame\./.test(line)) return;
    for (const key of forbiddenFrameKeys) {
      const keyPattern = new RegExp(`['"\`]${key}['"\`]|\\.${key}\\b`);
      if (keyPattern.test(line)) {
        failures.push(`${relPath}:${index + 1}: SSE frame projection references forbidden internal key "${key}"`);
      }
    }
  });
}

const retiredPaths = [
  'sharedmodule/llmswitch-core/src/sse/types/conversion-context.ts',
  'sharedmodule/llmswitch-core/src/sse/types/stream-state.ts',
  'sharedmodule/llmswitch-core/src/sse/types/utility-types.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/constants.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/serializers/base-serializer.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/serializers/chat-event-serializer.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/serializers/index.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/serializers/types.ts',
];

for (const relPath of retiredPaths) {
  if (fs.existsSync(path.join(root, relPath))) {
    failures.push(`retired SSE wrapper/path resurrected: ${relPath}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:sse-architecture-boundary] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:sse-architecture-boundary] ok');
console.log(`- checked SSE features: ${requiredFeatures.length}`);
console.log(`- checked SSE source files: ${sourceFiles.length}`);
