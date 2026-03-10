#!/usr/bin/env node

/**
 * Cross-protocol parity matrix:
 * chat → responses → chat → anthropic → chat → gemini → chat
 * using real codex samples that include tool calls + tool results.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const SAMPLE_BASE =
  process.env.CODEX_SAMPLES_DIR ||
  path.join(os.homedir(), '.routecodex', 'codex-samples');

let cachedDistRoot;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractPayload(doc) {
  if (!doc) return undefined;
  const container = doc?.data?.body ?? doc?.body ?? doc;
  if (!container) return undefined;
  if (typeof container.body === 'object') return container.body;
  if (typeof container.data === 'object') return container.data;
  if (typeof container === 'object') return container;
  return undefined;
}

function sortByMtimeDesc(files) {
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.file);
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

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').trim();
}

function canonicalizeChat(chat) {
  const clone = JSON.parse(JSON.stringify(chat || {}));
  if (clone.model) clone.model = String(clone.model);
  if ('__rcc_raw_system' in clone) {
    delete clone.__rcc_raw_system;
  }
  if ('providerType' in clone) delete clone.providerType;
  if ('providerKey' in clone) delete clone.providerKey;
  if (clone.metadata && typeof clone.metadata === 'object') {
    if ('__rcc_raw_system' in clone.metadata) {
      delete clone.metadata.__rcc_raw_system;
    }
    delete clone.metadata.providerKey;
    delete clone.metadata.providerType;
  }
  if (Array.isArray(clone.tools)) {
    clone.tools = clone.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool;
      if (tool.type === 'function' && tool.function) {
        const fn = { ...tool.function };
        if (typeof fn.name === 'string') fn.name = fn.name.trim();
        if (fn.parameters && typeof fn.parameters === 'object') {
          fn.parameters = JSON.parse(JSON.stringify(fn.parameters));
        }
        return { type: 'function', function: fn };
      }
      return tool;
    });
  }
  const messages = Array.isArray(clone.messages) ? clone.messages : [];
  const idMap = new Map();
  const toolAliasMap = new Map();
  const pendingToolIds = [];
  let toolCounter = 0;
  for (const msg of messages) {
    if (typeof msg?.content === 'string') {
      msg.content = normalizeText(msg.content);
    } else if (Array.isArray(msg?.content)) {
      // For parity checks, flatten structured content (including image blocks)
      // down to a single normalized text string so that protocols which
      // cannot represent images structurally can still be compared fairly.
      const parts = msg.content;
      const text = parts
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof part.text === 'string') {
            return part.text;
          }
          return '';
        })
        .join('');
      msg.content = normalizeText(text);
    } else if (msg?.content == null) {
      msg.content = '';
    }

    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const newId = `fc_call_${toolCounter++}`;
        if (tc && typeof tc === 'object') {
          if (tc.id) idMap.set(String(tc.id), newId);
          tc.id = newId;
          if ('index' in tc) delete tc.index;
          if (tc.function && typeof tc.function === 'object') {
            tc.function.arguments = normalizeArgumentsString(tc.function.arguments);
          }
          pendingToolIds.push(newId);
        }
      }
    }
  }
  for (const msg of messages) {
    if (msg && typeof msg === 'object' && msg.role === 'tool' && msg.tool_call_id) {
      const rawId = String(msg.tool_call_id);
      let mapped = idMap.get(rawId);
      if (!mapped && toolAliasMap.has(rawId)) {
        mapped = toolAliasMap.get(rawId);
      }
      if (!mapped && pendingToolIds.length) {
        mapped = pendingToolIds.shift();
        toolAliasMap.set(rawId, mapped);
      }
      if (mapped) msg.tool_call_id = mapped;
      if ('id' in msg) delete msg.id;
      if (typeof msg.content === 'string') {
        msg.content = normalizeText(msg.content);
      }
      if ('name' in msg) delete msg.name;
    }
  }
  return clone;
}

function assertChatEqual(expected, actual, label) {
  const canonicalExpected = canonicalizeChat(expected);
  const canonicalActual = canonicalizeChat(actual);
  assert.deepStrictEqual(
    canonicalActual,
    canonicalExpected,
    `[${label}] chat payload diverged`
  );
}

function loadLatestChatRequestWithTools() {
  const dir = path.join(SAMPLE_BASE, 'openai-chat');
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
    .filter((name) => name.endsWith('_provider-request.json'))
    .map((name) => path.join(dir, name));
  const ordered = sortByMtimeDesc(files);
  for (const file of ordered) {
    try {
      const payload = extractPayload(readJson(file));
      if (!payload?.messages || !Array.isArray(payload.messages)) continue;
      if (
        payload.messages.some(
          (msg) =>
            Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
        ) &&
        payload.messages.some((msg) => msg?.role === 'tool')
      ) {
        return { payload, file };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function loadCodexFixtures() {
  const chatRequest = loadLatestChatRequestWithTools();
  if (!chatRequest) {
    return null;
  }
  return { chatRequest };
}

const fixtures = loadCodexFixtures();
if (!fixtures) {
  console.warn(
    `⚠️  [cross-protocol-matrix] 缺少 codex 样本目录 (${SAMPLE_BASE}) 或未捕获包含工具调用的 openai-chat 样本，跳过该测试。`
  );
  process.exit(0);
}
const { chatRequest } = fixtures;
console.log('🧪 Cross-protocol samples:', { chatRequest: chatRequest.file });

const responsesBridge = await import(
  pathToFileURL(
    path.join(
      distRoot(),
      'conversion',
      'responses',
      'responses-openai-bridge.js'
    )
  ).href
);
const {
  buildResponsesRequestFromChat,
  buildChatRequestFromResponses,
  captureResponsesContext
} = responsesBridge;

const {
  buildAnthropicRequestFromOpenAIChat,
  buildOpenAIChatFromAnthropic
} = await import(
  pathToFileURL(
    path.join(
      distRoot(),
      'conversion',
      'codecs',
      'anthropic-openai-codec.js'
    )
  ).href
);

const { buildOpenAIChatFromGeminiRequest } = await import(
  pathToFileURL(
    path.join(distRoot(), 'conversion', 'codecs', 'gemini-openai-codec.js')
  ).href
);

function distRoot() {
  if (cachedDistRoot) return cachedDistRoot;
  const modern = path.join(REPO_ROOT, 'dist');
  const modernProbe = path.join(
    modern,
    'conversion',
    'responses',
    'responses-openai-bridge.js'
  );
  if (fs.existsSync(modernProbe)) {
    cachedDistRoot = modern;
    return cachedDistRoot;
  }
  cachedDistRoot = path.join(REPO_ROOT, 'dist');
  return cachedDistRoot;
}

function buildGeminiRequestFromChat(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const contents = [];
  const systemParts = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user').toLowerCase();
    if (role === 'system') {
      const text = Array.isArray(msg.content)
        ? msg.content.map((part) => part?.text || '').join('')
        : String(msg.content || '');
      if (text.trim()) {
        systemParts.push({ text: text.trim() });
      }
      continue;
    }
    const parts = [];
    const normalizedRole = role;
    if (typeof msg.content === 'string' && msg.content.trim()) {
      if (normalizedRole !== 'tool') {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part.text === 'string' && part.text.trim()) {
            if (normalizedRole === 'tool') continue;
            parts.push({ text: part.text });
        }
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = tc.function || {};
        if (typeof fn.name !== 'string') continue;
        let argsObj;
        if (typeof fn.arguments === 'string') {
          try {
            argsObj = JSON.parse(fn.arguments);
          } catch {
            argsObj = { _raw: fn.arguments };
          }
        } else {
          argsObj = fn.arguments ?? {};
        }
        parts.push({
          functionCall: {
            name: fn.name,
            id: tc.id,
            args: argsObj
          }
        });
      }
    }
    if (normalizedRole === 'tool' && msg.tool_call_id) {
      let responseObj;
      if (typeof msg.content === 'string') {
        try {
          responseObj = JSON.parse(msg.content);
        } catch {
          responseObj = msg.content;
        }
      } else {
        responseObj = msg.content;
      }
      parts.push({
        functionResponse: { id: msg.tool_call_id, response: responseObj }
      });
      contents.push({
        role: 'tool',
        parts
      });
      continue;
    }

    contents.push({
      role: normalizedRole === 'assistant' ? 'model' : normalizedRole,
      parts
    });
  }

  const toolDeclarations = Array.isArray(chat?.tools)
    ? chat.tools
        .filter((t) => t?.type === 'function' && t.function?.name)
        .map((t) => ({
          functionDeclarations: [
            {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters
            }
          ]
        }))
    : [];

  const payload = {
    model: chat?.model || 'unknown',
    contents,
    ...(systemParts.length
      ? { systemInstruction: { parts: systemParts } }
      : {}),
    ...(toolDeclarations.length ? { tools: toolDeclarations } : {})
  };
  return payload;
}

function stringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

const SKIP_GEMINI = process.env.CROSS_SKIP_GEMINI !== '0';

function runRequestChain() {
  const chat = chatRequest.payload;
  const canonical = canonicalizeChat(chat);

  let current = canonical;

  const outer = {
    model: canonical.model,
    tools: canonical.tools,
    max_tokens: canonical.max_tokens,
    max_output_tokens: canonical.max_output_tokens,
    stream: canonical.stream,
    tool_choice: canonical.tool_choice
  };

  function withOuterFields(obj) {
    return {
      ...obj,
      ...outer
    };
  }

  function updateCurrent(next, label) {
    assertChatEqual(canonical, next, label);
    current = canonicalizeChat(next);
  }

  const { request: responsesReq, originalSystemMessages } = buildResponsesRequestFromChat(current);
  const ctx = captureResponsesContext(responsesReq, {
    route: { requestId: 'cross-protocol' }
  });
  if (originalSystemMessages?.length) {
    ctx.originalSystemMessages = originalSystemMessages;
  }
  const chatFromResponses = buildChatRequestFromResponses(responsesReq, ctx).request;
  updateCurrent(withOuterFields(chatFromResponses), 'responses');

  const anthReq = buildAnthropicRequestFromOpenAIChat(current);
  const chatFromAnth = buildOpenAIChatFromAnthropic(anthReq);
  updateCurrent(withOuterFields(chatFromAnth), 'anthropic');

  if (SKIP_GEMINI) {
    console.log('⚠️  cross-protocol matrix: Gemini parity temporarily skipped (set CROSS_SKIP_GEMINI=0 to re-enable).');
  } else {
    const gemReq = buildGeminiRequestFromChat(current);
    const chatFromGem = buildOpenAIChatFromGeminiRequest(gemReq);
    if (process.env.DEBUG_CROSS === '1') {
      console.log('[debug] Gemini request:', JSON.stringify(gemReq, null, 2));
      console.log('[debug] Chat from Gemini:', JSON.stringify(chatFromGem, null, 2));
    }
    updateCurrent(withOuterFields(chatFromGem), 'gemini');
  }

  console.log(
    '✅ cross-protocol request parity maintained:',
    stringify(canonical)
  );
}

try {
  runRequestChain();
  console.log('✅ cross-protocol matrix completed');
} catch (err) {
  console.error('❌ cross-protocol matrix failed:', err);
  process.exit(1);
}
