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

const retiredResponsesSerializerPath =
  'sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts';
if (fs.existsSync(path.join(root, retiredResponsesSerializerPath))) {
  failures.push(`${retiredResponsesSerializerPath} must stay physically deleted; Responses wire codec is Rust-owned`);
}

const responsesEventGenerator = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts');
for (const forbidden of [
  'function createResponsePayload(',
  'function normalizeUsage(',
  'function normalizeReasoningSummaryEntries(',
  'function normalizeReasoningSummaryField(',
  'const TEXT_CHUNK_BOUNDARY',
  'function getChunkSize(',
  'function chunkText(',
  'StringUtils.chunkString(',
  'basePayload.output = []',
  'const itemDescriptor: Record<string, unknown>',
  'output_index: context.outputIndexCounter,',
  '...(outputItem as any)',
  'const partDescriptor: Record<string, unknown>',
  'item_id: outputItemId,',
  'content_index: contentIndex,',
  '(content as any).annotations',
  '(content as any).logprobs',
  'logprobs: []',
  'call_id: functionCall.call_id',
  'arguments: functionCall.arguments',
  'if (item.arguments) {',
  'if (!functionCall.arguments) return;',
  "part: { type: 'summary_text'",
  'delta: content.text',
  'signature: content.signature',
  'image_url: content.image_url',
  'item_id: reasoning.id',
  'summary: normalizeReasoningSummaryFieldWithNative',
  'data: {\n        ...delta\n      }',
  'data: {\n        ...done\n      }',
  'data: {\n        ...payload\n      }',
  'data: {\n        ...partAdded\n      }',
  'data: {\n        ...textDone\n      }',
  'data: {\n        ...partDone\n      }',
  "type: 'internal_error'",
  "code: 'generation_error'",
  'created_at: response.created_at ?? Math.floor(Date.now() / 1000)',
  'response.created_at ?? Math.floor(Date.now() / 1000)',
  "import { TimeUtils } from '../../shared/utils.js';",
  'function getNextSequenceNumber(',
  'function createBaseEvent(',
  'prompt_tokens',
  'completion_tokens',
  'cache_read_input_tokens',
  'function collapseWhitespace(',
  'function stripReasoningLinePrefix(',
  'function compactReasoningSummaryBody(',
  'function normalizeReasoningSummaryText(',
  '**Thinking**',
]) {
  if (responsesEventGenerator.includes(forbidden)) {
    failures.push(`Responses SSE generator must not keep usage/reasoning compatibility marker: ${forbidden}`);
  }
}

const responsesJsonToSseConverter = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts');
for (const forbidden of [
  'responsesRequest: {} as any',
  'outputItemStates: new Map()',
]) {
  if (responsesJsonToSseConverter.includes(forbidden)) {
    failures.push(`Responses JSON->SSE converter must not keep dead context state: ${forbidden}`);
  }
}

const responsesSequencer = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts');
for (const forbidden of [
  'function normalizeResponseOutput(',
  'suppressReasoningFromContent: hasExplicitReasoning',
  'function canonicalizeResponsesEventPayload(',
  'data: {\n      type: event.type,',
  'sequence_number: event.sequenceNumber',
  'Responses event payload type mismatch: event=',
  'enableRecovery: boolean',
  'enableRecovery: true',
  'if (config.enableRecovery) {',
  'yield buildErrorEvent(error as Error, context, config);',
]) {
  if (responsesSequencer.includes(forbidden)) {
    failures.push(`Responses sequencer must not locally canonicalize SSE payload semantics: ${forbidden}`);
  }
}

const responsesOutputNormalizer = read('sharedmodule/llmswitch-core/src/sse/shared/responses-output-normalizer.ts');
for (const forbidden of [
  'normalizeMessageContentParts(',
  'const baseId =',
  'suppressReasoningFromContent',
  'extraReasoning',
  '`${baseId}_reasoning`',
  "return reasoning ? [reasoning, message] : [message]",
]) {
  if (responsesOutputNormalizer.includes(forbidden)) {
    failures.push(`Responses output normalizer must not own message/reasoning split semantics in TS: ${forbidden}`);
  }
}

const chatEventGenerator = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/chat.ts');
for (const forbidden of [
  "import { TimeUtils } from '../../shared/utils.js';",
  'timestamp: TimeUtils.now()',
  'sequenceNumber: 0',
  "type: 'internal_error'",
  "code: 'generation_error'",
  "delta: { role: role as 'user' | 'system' | 'assistant' | 'tool' }",
  'delta: { content }',
  'delta: { reasoning, reasoning_content: reasoning }',
  'function: { arguments: args }',
  "arguments: ''",
  'function normalizeChatUsage(',
  'const normalizedUsage = normalizeChatUsage(usage);',
  'delta: {},\n      logprobs: null,\n      finish_reason: finishReason',
  'id: context.responseId ?? context.requestId',
  'created: context.created ?? (config.enableTimestampGeneration ? Math.floor(TimeUtils.now() / 1000) : 0)',
  'if (!usage || typeof usage !== \'object\' || Array.isArray(usage)) {\n    return undefined;\n  }',
  'if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {\n    return undefined;\n  }',
  'record.input_tokens',
  'record.output_tokens',
  'record.promptTokens',
  'record.completionTokens',
  'record.inputTokens',
  'record.outputTokens',
  'record.totalTokens',
  '(promptTokens ?? 0) + (completionTokens ?? 0)',
]) {
  if (chatEventGenerator.includes(forbidden)) {
    failures.push(`Chat SSE generator must not synthesize response id/created/usage truth: ${forbidden}`);
  }
}

const sharedOwnerFiles = [
  'sharedmodule/llmswitch-core/src/sse/registry/sse-codec-registry.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/writer.ts',
  'sharedmodule/llmswitch-core/src/sse/shared/utils.ts',
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

const sseParser = read('sharedmodule/llmswitch-core/src/sse/sse-to-json/parsers/sse-parser.ts');
if (sseParser.includes('enableEventRecovery: true')) {
  failures.push('SSE parser default must not enable event recovery');
}

const anthropicResponseBuilder = read('sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/anthropic-response-builder.ts');
for (const forbidden of [
  'state.id || `msg_${Date.now()}`',
  "state.role || 'assistant'",
  "state.model || 'unknown'",
  'input = { _raw: block.buffer }',
  '_raw: block.buffer',
]) {
  if (anthropicResponseBuilder.includes(forbidden)) {
    failures.push(`Anthropic SSE builder resurrects message fallback: ${forbidden}`);
  }
}

const anthropicEventSerializer = read('sharedmodule/llmswitch-core/src/sse/shared/serializers/anthropic-event-serializer.ts');
for (const forbidden of [
  ": 'message')",
  "event.type ||\n    (typeof (payload as Record<string, unknown>)?.type === 'string'",
]) {
  if (anthropicEventSerializer.includes(forbidden)) {
    failures.push(`Anthropic SSE serializer must not synthesize fallback event types: ${forbidden}`);
  }
}

const anthropicSequencer = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/anthropic-sequencer.ts');
for (const forbidden of [
  "response.stop_reason ?? 'end_turn'",
  'timestamp: Date.now()',
  "if (!block || typeof block !== 'object') continue;",
  "block.text ?? ''",
  "const data = typeof block.data === 'string' ? block.data : '';",
  'if (!data.trim().length) {\n            continue;\n          }',
  'response.content || []',
  'block.input ?? {}',
  'JSON.stringify(input ?? {})',
]) {
  if (anthropicSequencer.includes(forbidden)) {
    failures.push(`Anthropic SSE sequencer must not synthesize fallback/event envelope truth: ${forbidden}`);
  }
}
if (!anthropicSequencer.includes('Invalid Anthropic tool_result block: missing tool_use_id')) {
  failures.push('Anthropic SSE sequencer must fail fast when tool_result.tool_use_id is missing');
}

const geminiEventSerializer = read('sharedmodule/llmswitch-core/src/sse/shared/serializers/gemini-event-serializer.ts');
for (const forbidden of [
  "event.event ?? event.type ?? 'gemini.data'",
]) {
  if (geminiEventSerializer.includes(forbidden)) {
    failures.push(`Gemini SSE serializer must not synthesize fallback event types: ${forbidden}`);
  }
}

const geminiSequencer = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/gemini-sequencer.ts');
for (const forbidden of [
  'parts.filter((part): part is GeminiContentPart => Boolean(part))',
  'sequenceNumber: 0',
  'timestamp: Date.now()',
  'Array.isArray(response.candidates) ? response.candidates : []',
  'candidates[candidateIndex] || {}',
  "if (!part || typeof part !== 'object') {\n    return [part];\n  }",
  'return [];',
]) {
  if (geminiSequencer.includes(forbidden)) {
    failures.push(`Gemini SSE sequencer must not synthesize fallback event truth: ${forbidden}`);
  }
}

const providerNeutralProjectionFiles = [
  'sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts',
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
    'enableEventRecovery: true',
    'enableEventRecovery: !this.config.strictMode',
    'tryMaterializeFinalResponse',
    'getSalvageResult',
    'const salvaged =',
    'return salvaged',
    'best effort',
    'Ignore non-JSON lines so valid partial frames can still be recovered.',
    '忽略解析错误',
    'keep raw payload only',
    'const fallback = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }',
    "response.status ?? 'requires_action'",
    "response.status ?? 'completed'",
    'if (!content.text) continue;',
    'normalizeResponsesSseReasoningSummaryWithNative(reasoning.summary) ?? []',
    'if (!text) continue;',
    "args = '{}'",
    'return String(raw)',
    "outputItemState.arguments = '{}'",
    'logResponseBuilderNonBlocking',
    'fallbackCode',
    'fallbackMessage',
    "fallback = 'model'",
    "return String(input ?? '')",
    'response.id || `msg_${requestId}`',
    "response.role || 'assistant'",
    "role: messageBuilder.role || 'assistant'",
    'block.id || `call_${requestId}_${index}`',
    'context.currentResponse.id || `chat_${context.requestId}`',
    'context.currentResponse.created || Math.floor(Date.now() / 1000)',
    'call_${Math.random().toString(36).slice(2, 10)}',
    'JSON.stringify(fc?.arguments ?? {})',
    "typeof fc?.id === 'string' ? fc.id : `call_${Math.random().toString(36).slice(2, 10)}`",
    "role: typeof d.role === 'string' ? d.role : 'assistant'",
    "const et = (event && (event.event || event.type)) || 'unknown'",
    'syntheticResponse',
    'syntheticIndex',
    "id: `${context.requestId}-input-${inputIndex}`",
    'message_placeholder_',
    'createResponseBuilder(',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath}: provider-neutral SSE projection must not salvage partial streams into successful responses: ${forbidden}`);
    }
  }
}

const chatSseToJsonConverter = read('sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts');
for (const forbidden of [
  'function normalizeChatUsage(usage: unknown): ChatUsage | null',
  'function normalizeChatUsage(usage: unknown): ChatUsage | undefined',
  'function readNonNegativeInteger(',
  'if (!usage || typeof usage !== \'object\' || Array.isArray(usage)) {\n    return null;\n  }',
  'if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {\n    return null;\n  }',
  "id: context.currentResponse.id || ''",
  'created: context.currentResponse.created || 0',
  "message: choice.message || { role: 'assistant', content: '' }",
  'const normalizedUsage = normalizeChatUsage(chunk.usage);',
  'const directUsage = normalizeChatUsage(_context.currentResponse.usage);',
]) {
  if (chatSseToJsonConverter.includes(forbidden)) {
    failures.push(`Chat SSE decode must not synthesize missing response truth: ${forbidden}`);
  }
}

for (const forbidden of [
  'convertRequestToJsonToSse(',
  'processRequestToSseWithFunctions',
  'createRequestContext(request:',
  'sequenceRequest(request, context.requestId)',
]) {
  if (responsesJsonToSseConverter.includes(forbidden)) {
    failures.push(`Responses JSON->SSE must not synthesize request payloads into response SSE: ${forbidden}`);
  }
}

const chatJsonToSseConverter = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.ts');
for (const forbidden of [
  'convertRequestToJsonToSse(',
  'processRequestToSseWithFunctions',
  'createRequestContext(request:',
]) {
  if (chatJsonToSseConverter.includes(forbidden)) {
    failures.push(`Chat JSON->SSE must not synthesize request payloads into response SSE: ${forbidden}`);
  }
}

const chatSequencer = read('sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/chat-sequencer.ts');
for (const forbidden of [
  'sequenceChatRequest(',
  'sequenceRequest(request',
  'yield* sequenceChatRequest',
]) {
  if (chatSequencer.includes(forbidden)) {
    failures.push(`Chat sequencer must not expose request-to-SSE response synthesis: ${forbidden}`);
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
  for (const forbidden of [
    '/* noop */',
    '/* ignore */',
    'Never throw from non-blocking logging',
    'non-blocking',
    'logChatJsonToSseNonBlocking',
    'catch {}',
    '} catch {',
    'message_placeholder_',
    'createResponseBuilder(',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath}: SSE runtime must not contain silent failure marker: ${forbidden}`);
    }
  }

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
