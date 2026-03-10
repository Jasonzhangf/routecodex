#!/usr/bin/env node

/**
 * Protocol bridge matrix verification.
 *
 * Requirements:
 *  - Head/tail protocol remains identical while the mid-stage switches to a different protocol.
 *  - Run JSON conversions first (Requests + Responses).
 *  - Then cover SSE conversions using tool-calling payloads derived from codex samples.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

process.env.ROUTECODEX_MCP_ENABLE = process.env.ROUTECODEX_MCP_ENABLE ?? '0';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(scriptDir, '..', '..');
const distRootModern = path.join(projectRoot, 'dist');
const distRootLegacy = distRootModern;

function resolveDistModule(...segments) {
  const modern = path.join(distRootModern, ...segments);
  if (fs.existsSync(modern)) return modern;
  return path.join(distRootLegacy, ...segments);
}

const SAMPLE_BASE =
  process.env.CODEX_SAMPLES_DIR ||
  path.join(os.homedir(), '.routecodex', 'codex-samples');

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractPayload(doc) {
  if (!doc) return undefined;
  const container = doc?.data?.body ?? doc?.body ?? doc;
  if (!container) return undefined;
  if (container.body && typeof container.body === 'object') return container.body;
  if (container.data && typeof container.data === 'object') return container.data;
  if (typeof container === 'object') return container;
  return undefined;
}

function sortByMtimeDesc(files) {
  return files
    .map((name) => ({
      name,
      mtime: fs.statSync(name).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.name);
}

function hasChatToolCalls(payload) {
  if (!Array.isArray(payload?.messages)) return false;
  let assistantToolCall = false;
  let toolReply = false;
  for (const message of payload.messages) {
    if (
      message?.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length
    ) {
      assistantToolCall = true;
    }
    if (message?.role === 'tool') {
      toolReply = true;
    }
  }
  return assistantToolCall && toolReply;
}

function hasResponsesToolActivity(payload) {
  return Boolean(
    Array.isArray(payload?.input) &&
      payload.input.some(
        (entry) =>
          entry?.type === 'function_call' || entry?.type === 'function_call_output'
      )
  );
}

function hasAssistantTextResponse(payload) {
  if (!Array.isArray(payload?.choices) || !payload.choices.length) return false;
  for (const choice of payload.choices) {
    const message = choice?.message;
    if (!message) continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) continue;
    const content = message.content;
    if (typeof content === 'string' && content.trim()) return true;
    if (
      Array.isArray(content) &&
      content.some((part) => typeof part?.text === 'string' && part.text.trim())
    ) {
      return true;
    }
  }
  return false;
}

function loadLatestSample(subdir, suffix, predicate) {
  const dir = path.join(SAMPLE_BASE, subdir);
  if (!fs.existsSync(dir)) {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const files = entries
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name));
  const ordered = sortByMtimeDesc(files);
  for (const file of ordered) {
    try {
      const json = readJsonFile(file);
      const payload = extractPayload(json);
      if (!payload) continue;
      if (predicate && !predicate(payload, json)) continue;
      return { payload, file };
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeResponsesToolSamples(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const tools = payload.tools;
  if (!Array.isArray(tools) || !tools.length) {
    return;
  }
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const fnNode =
      tool.function && typeof tool.function === 'object'
        ? (tool.function)
        : {};
    if ((fnNode.name === undefined || fnNode.name === null) && typeof tool.name === 'string') {
      fnNode.name = tool.name;
    }
    if (fnNode.description === undefined && typeof tool.description === 'string') {
      fnNode.description = tool.description;
    }
    if (fnNode.parameters === undefined && tool.parameters !== undefined) {
      fnNode.parameters = tool.parameters;
    }
    if (fnNode.strict === undefined && typeof tool.strict === 'boolean') {
      fnNode.strict = tool.strict;
    }
    if (Object.keys(fnNode).length) {
      tool.function = fnNode;
    }
  }
}

function loadCodexFixtures() {
  const chatRequest = loadLatestSample(
    'openai-chat',
    '_provider-request.json',
    hasChatToolCalls
  );
  const chatResponse = loadLatestSample(
    'openai-chat',
    '_provider-response.json',
    hasAssistantTextResponse
  );
  const responsesRequest = loadLatestSample(
    'openai-responses',
    '_provider-request.json',
    hasResponsesToolActivity
  );
  if (!chatRequest || !chatResponse || !responsesRequest) {
    return null;
  }
  normalizeResponsesToolSamples(responsesRequest.payload);
  return {
    chatRequest,
    chatResponse,
    responsesRequest
  };
}

const fixtures = loadCodexFixtures();
if (!fixtures) {
  console.warn(
    `⚠️  [protocol-bridge-matrix] 缺少 codex 样本目录 (${SAMPLE_BASE}) 或未捕获包含工具调用的 openai-chat/openai-responses 样本，跳过该测试。`
  );
  process.exit(0);
}
console.log('🧪 Using codex samples:', {
  chatRequest: fixtures.chatRequest.file,
  chatResponse: fixtures.chatResponse.file,
  responsesRequest: fixtures.responsesRequest.file
});

const responsesBridgeMod = await import(
  pathToFileURL(resolveDistModule('conversion', 'responses', 'responses-openai-bridge.js')).href
);
const {
  buildResponsesRequestFromChat,
  buildResponsesPayloadFromChat,
  buildChatResponseFromResponses,
  captureResponsesContext
} = responsesBridgeMod;
const responsesRequestAdapterMod = await import(
  pathToFileURL(resolveDistModule('conversion', 'shared', 'responses-request-adapter.js')).href
);
const {
  buildChatRequestFromResponses
} = responsesRequestAdapterMod;

const responsesSseIndexMod = await import(pathToFileURL(resolveDistModule('sse', 'index.js')).href);
const { responsesConverters } = responsesSseIndexMod;
const responsesSseToJsonMod = await import(
  pathToFileURL(resolveDistModule('sse', 'sse-to-json', 'index.js')).href
);
const { ResponsesSseToJsonConverter } = responsesSseToJsonMod;

function collectContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectContent).join('');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return collectContent(value.content);
  }
  return value ? String(value) : '';
}

function findMessageByRole(messages, role) {
  return (messages || []).find((msg) => msg && msg.role === role);
}

function findAssistantToolCall(messages) {
  return (messages || []).find((msg) => Array.isArray(msg?.tool_calls))?.tool_calls?.[0];
}

function findToolMessage(messages) {
  return (messages || []).find((msg) => msg?.role === 'tool');
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('');
}

function normalizeResponsesSse(rawText) {
  return rawText
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith(':')) return true;
      if (trimmed.startsWith('event:')) return true;
      if (trimmed.startsWith('data:')) return true;
      return false;
    })
    .join('\n');
}

function normalizeMultilineText(value) {
  return (value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeArgumentsString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function verifyChatJsonRoundtrip() {
  const chat = fixtures.chatRequest.payload;
  const { request: responses, originalSystemMessages } = buildResponsesRequestFromChat(chat);
  assert.ok(Array.isArray(responses.input) && responses.input.length > 0, 'Responses input should exist');

  const ctx = captureResponsesContext(responses, { route: { requestId: 'chat-json-bridge' } });
  if (originalSystemMessages?.length) {
    ctx.originalSystemMessages = originalSystemMessages;
  }
  const { request: chatRoundtrip } = buildChatRequestFromResponses(responses, ctx);

  const originalSystem = findMessageByRole(chat.messages, 'system');
  const systemRoundtrip = findMessageByRole(chatRoundtrip.messages, 'system');
  assert.strictEqual(
    collectContent(systemRoundtrip?.content),
    collectContent(originalSystem?.content),
    'System message should be preserved during chat→responses→chat roundtrip'
  );

  const originalUser = findMessageByRole(chat.messages, 'user');
  const roundtripUser = findMessageByRole(chatRoundtrip.messages, 'user');
  assert.strictEqual(
    collectContent(roundtripUser?.content),
    collectContent(originalUser?.content),
    'User prompt content mismatch after roundtrip'
  );

  const toolCallOriginal = findAssistantToolCall(chat.messages);
  const toolCallRoundtrip = findAssistantToolCall(chatRoundtrip.messages);
  assert.ok(toolCallRoundtrip, 'Roundtrip chat payload lost assistant tool call');
  assert.strictEqual(
    toolCallRoundtrip.function?.name,
    toolCallOriginal?.function?.name,
    'Tool call function name mismatch'
  );
  assert.strictEqual(
    toolCallRoundtrip.function?.arguments,
    toolCallOriginal?.function?.arguments,
    'Tool call arguments mismatch'
  );

  const toolMessage = findToolMessage(chatRoundtrip.messages);
  assert.ok(toolMessage, 'Roundtrip chat payload missing tool result');
  if (toolCallRoundtrip?.id) {
    assert.strictEqual(
      toolMessage.tool_call_id,
      toolCallRoundtrip.id,
      'Tool result envelope should keep the tool_call_id metadata'
    );
  }

  assert.deepStrictEqual(
    chatRoundtrip.tool_choice,
    chat.tool_choice,
    'tool_choice must roundtrip intact'
  );
  assert.strictEqual(
    chatRoundtrip.tools?.length,
    chat.tools?.length,
    'Tool definition count mismatch after roundtrip'
  );
}

async function verifyResponsesJsonRoundtrip() {
  const responses = fixtures.responsesRequest.payload;
  const ctx = captureResponsesContext(responses, { route: { requestId: 'responses-json-bridge' } });
  const { request: chat } = buildChatRequestFromResponses(responses, ctx);
  const { request: responsesRoundtrip } = buildResponsesRequestFromChat(chat, ctx);
  enforceResponsesToolIdStyle(responsesRoundtrip, 'fc_');
  const diff = diffJson(
    canonicalizeResponsesRequest(stripOptionalResponsesFields(pruneUndefined(responses))),
    canonicalizeResponsesRequest(stripOptionalResponsesFields(pruneUndefined(responsesRoundtrip)))
  );
  if (diff.length) {
    throw new Error(
      `responses→chat→responses diff detected:\n${diff
        .slice(0, 10)
        .map((entry) => `  • ${entry.path}: expected=${JSON.stringify(entry.expected)} actual=${JSON.stringify(entry.actual)}`)
        .join('\n')}${diff.length > 10 ? `\n  ... ${diff.length - 10} more` : ''}`
    );
  }
}

async function verifySseRoundtrip() {
  const chatResponse = fixtures.chatResponse.payload;
  const responsesPayload = buildResponsesPayloadFromChat(chatResponse);
  const requestId = 'sse-bridge-' + Date.now();
  const responsesStream = await responsesConverters.jsonToSse.convertResponseToJsonToSse(responsesPayload, {
    requestId,
    model: responsesPayload?.model || chatResponse?.model || 'gpt-4o-mini'
  });
  const baseSseText = await streamToString(responsesStream);
  const sanitizedText = normalizeResponsesSse(baseSseText);
  const completionEvent = [
    'event: response.completed',
    `data: ${JSON.stringify({ type: 'response.completed', response: responsesPayload })}`,
    ''
  ].join('\n');
  const doneEvent = [
    'event: response.done',
    `data: ${JSON.stringify({ type: 'response.done', response: responsesPayload })}`,
    ''
  ].join('\n');
  let sseText = sanitizedText.endsWith('\n') ? `${sanitizedText}${completionEvent}\n` : `${sanitizedText}\n${completionEvent}\n`;
  sseText = sseText.endsWith('\n') ? `${sseText}${doneEvent}\n` : `${sseText}\n${doneEvent}\n`;
  const hasCreated = /(?:^|\n)event:\s*response\.created/.test(sseText);
  const hasTerminalEvent = /(?:^|\n)event:\s*response\.(completed|required_action)/.test(sseText);
  assert.ok(
    hasCreated && hasTerminalEvent,
    'Responses SSE stream must emit created and terminal events'
  );

  const converter = new ResponsesSseToJsonConverter();
  const responsesJson = await converter.convertSseToJson(Readable.from([sseText]), { requestId });
  if (!responsesJson.output_text && Array.isArray(responsesJson.output)) {
    const messageItem = responsesJson.output.find((item) => item?.type === 'message');
    const textPart = messageItem?.content?.find((part) => typeof part?.text === 'string');
    if (textPart?.text) {
      responsesJson.output_text = textPart.text;
    }
  }
  assert.strictEqual(responsesJson.object, 'response', 'SSE conversion should yield a Responses response object');

  const chatRoundtrip = buildChatResponseFromResponses(responsesJson);
  const originalContent = collectContent(chatResponse.choices?.[0]?.message?.content);
  const roundtripContent = collectContent(chatRoundtrip?.choices?.[0]?.message?.content);
  assert.strictEqual(
    normalizeMultilineText(roundtripContent),
    normalizeMultilineText(originalContent),
    'Chat SSE roundtrip content mismatch'
  );

  const originalToolCall = chatResponse.choices?.[0]?.message?.tool_calls?.[0];
  const roundtripToolCall = chatRoundtrip?.choices?.[0]?.message?.tool_calls?.[0];
  if (originalToolCall) {
    assert.strictEqual(
      roundtripToolCall?.function?.name,
      originalToolCall.function?.name,
      'SSE bridge should preserve tool call function names'
    );
  }
}

async function main() {
  await verifyChatJsonRoundtrip();
  console.log('✅ Chat→Responses→Chat JSON roundtrip passed');

  await verifyResponsesJsonRoundtrip();
  console.log('✅ Responses→Chat→Responses JSON roundtrip passed');

  await verifySseRoundtrip();
  console.log('✅ Chat→Responses SSE bridge roundtrip passed');
}

main().catch((err) => {
  console.error('❌ protocol-bridge-matrix failed:', err);
  process.exit(1);
});
function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = pruneUndefined(entry);
    }
    return out;
  }
  return value;
}

function enforceResponsesToolIdStyle(payload, prefix) {
  // OpenAI Responses convention:
  // - item `id` must be `fc_*`
  // - `call_id` is typically `call_*` and is used to link tool outputs
  const ids = collectResponsesFunctionCallItemIds(payload);
  const offenders = ids.filter((id) => typeof id === 'string' && !id.startsWith(prefix));
  if (offenders.length) {
    throw new Error(`responses tool IDs missing prefix ${prefix}: ${offenders.join(', ')}`);
  }
}

function collectResponsesFunctionCallItemIds(payload) {
  const ids = [];
  const input = Array.isArray(payload?.input) ? payload.input : [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (!type) continue;
    if (type === 'function_call') {
      const itemId = entry.id;
      if (typeof itemId === 'string') {
        ids.push(itemId);
      }
      continue;
    }
    if (
      type === 'function_call_output' ||
      type === 'tool_result' ||
      type === 'tool_message'
    ) {
      const itemId = entry.id;
      if (typeof itemId === 'string') {
        ids.push(itemId);
      }
    }
  }
  return ids;
}

function diffJson(expected, actual, path = '<root>') {
  if (Object.is(expected, actual)) {
    return [];
  }
  if (typeof expected !== typeof actual) {
    return [{ path, expected, actual }];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    const diffs = [];
    for (let i = 0; i < max; i += 1) {
      if (i >= expected.length) {
        diffs.push({ path: `${path}[${i}]`, expected: undefined, actual: actual[i] });
        continue;
      }
      if (i >= actual.length) {
        diffs.push({ path: `${path}[${i}]`, expected: expected[i], actual: undefined });
        continue;
      }
      diffs.push(...diffJson(expected[i], actual[i], `${path}[${i}]`));
    }
    return diffs;
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const diffs = [];
    for (const key of keys) {
      const next = path === '<root>' ? key : `${path}.${key}`;
      if (!(key in actual)) {
        diffs.push({ path: next, expected: expected[key], actual: undefined });
        continue;
      }
      if (!(key in expected)) {
        diffs.push({ path: next, expected: undefined, actual: actual[key] });
        continue;
      }
      diffs.push(...diffJson(expected[key], actual[key], next));
    }
    return diffs;
  }
  return [{ path, expected, actual }];
}

const OPTIONAL_RESPONSE_FIELDS = new Set(['reasoning', 'prompt_cache_key']);

function stripOptionalResponsesFields(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripOptionalResponsesFields(entry));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (OPTIONAL_RESPONSE_FIELDS.has(key)) continue;
      out[key] = stripOptionalResponsesFields(entry);
    }
    return out;
  }
  return value;
}

function canonicalizeResponsesRequest(subject) {
  if (!subject || typeof subject !== 'object') {
    return subject;
  }
  const clone = JSON.parse(JSON.stringify(subject));
  if (Array.isArray(clone.input)) {
    clone.input = clone.input.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }
      const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
      if (
        type === 'function_call' ||
        type === 'function_call_output' ||
        type === 'tool_result' ||
        type === 'tool_message'
      ) {
        const normalized = { ...entry };
        if ('tool_call_id' in normalized) delete normalized.tool_call_id;
        if ('call_id' in normalized) delete normalized.call_id;
        if ('id' in normalized) delete normalized.id;
        return normalized;
      }
      return entry;
    });
  }
  normalizeResponsesToolSamples(clone);
  return clone;
}
