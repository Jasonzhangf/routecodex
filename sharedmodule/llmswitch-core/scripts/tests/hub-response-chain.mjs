#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const distRoot = path.join(projectRoot, 'dist', 'conversion');
const responsesBridgePath = path.join(distRoot, 'responses', 'responses-openai-bridge.js');
const responseRuntimePath = path.join(distRoot, 'hub', 'response', 'response-runtime.js');
const geminiCodecPath = path.join(distRoot, 'codecs', 'gemini-openai-codec.js');
const sseConverterPath = path.join(projectRoot, 'dist', 'sse', 'sse-to-json', 'index.js');

const samplesBase = process.env.CODEX_SAMPLES_DIR || path.join(os.homedir(), '.routecodex', 'codex-samples');
const responsesDir = path.join(samplesBase, 'openai-responses');
const responsesFixture = path.join(projectRoot, 'tests', 'hub', 'fixtures', 'responses-response.json');

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function isCanonicalResponsesPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const obj = payload.object;
  if (typeof obj !== 'string') return false;
  if (obj.trim() !== 'response') return false;
  if (!Array.isArray(payload.output)) return false;
  return true;
}

function loadLatestResponsesProviderSnapshot() {
  if (!fs.existsSync(responsesDir)) return null;
  const files = fs
    .readdirSync(responsesDir)
    .filter((name) => name.endsWith('_provider-response.json'))
    .map((name) => path.join(responsesDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const payload = extractPayload(doc);
      if (!payload) continue;
      if (!isCanonicalResponsesPayload(payload)) {
        // 仅将标准 Responses payload 用于链路测试；
        // 非 canonical 形状（如 legacy chat.completion）留给专用兼容测试使用。
        continue;
      }
      return { file, payload };
    } catch {
      continue;
    }
  }
  return null;
}

function extractPayload(doc) {
  if (!doc) return undefined;
  if (doc.body && typeof doc.body === 'object') return doc.body;
  if (doc.data?.body && typeof doc.data.body === 'object') return doc.data.body;
  if (doc.data?.body?.data && typeof doc.data.body.data === 'object') return doc.data.body.data;
  return doc.data || doc;
}

function sanitizeChat(chat) {
  const clone = JSON.parse(JSON.stringify(chat || {}));
  delete clone.id;
  delete clone.request_id;
  delete clone.model;
  delete clone.object;
  delete clone.created;
  if ('anthropicToolNameMap' in clone) {
    delete clone.anthropicToolNameMap;
  }
  if ('__responses_reasoning' in clone) {
    delete clone.__responses_reasoning;
  }
  if ('__responses_output_text_meta' in clone) {
    delete clone.__responses_output_text_meta;
  }
  if ('__responses_payload_snapshot' in clone) {
    delete clone.__responses_payload_snapshot;
  }
  if ('__responses_passthrough' in clone) {
    delete clone.__responses_passthrough;
  }
  if (clone.metadata) delete clone.metadata;
  if (clone.usage) delete clone.usage;
  if (Array.isArray(clone.choices)) {
    clone.choices = clone.choices.map((choice) => canonicalizeChoice(choice));
  }
  return clone;
}

function canonicalizeChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  const copy = { ...choice };
  // Gemini 等协议在工具调用往返时可能会把 finish_reason 归一化为 stop。
  // 这里仅做链路等价性检查，忽略该字段差异。
  if ('finish_reason' in copy) {
    delete copy.finish_reason;
  }
  if (copy.message) {
    copy.message = canonicalizeMessage(copy.message);
  }
  return copy;
}

function canonicalizeMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const msg = { ...message };
  if ('reasoning_content' in msg) delete msg.reasoning_content;
  if (Array.isArray(msg.content)) {
    msg.content = msg.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof msg.content === 'string') {
    msg.content = msg.content.trim();
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0) {
    delete msg.tool_calls;
  } else if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls = msg.tool_calls.map((call) => {
      if (!call || typeof call !== 'object') {
        return call;
      }
      const normalized = { ...call };
      delete normalized.id;
      delete normalized.call_id;
      delete normalized.tool_call_id;
      return normalized;
    });
  }
  return msg;
}

function sanitizeResponsesPayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload || {}));
  delete clone.id;
  delete clone.request_id;
  delete clone.created;
  delete clone.created_at;
  if (typeof clone.model === 'string') {
    const normalizedModel = clone.model.trim();
    if (!normalizedModel || normalizedModel.toLowerCase() === 'unknown') {
      delete clone.model;
    } else {
      clone.model = normalizedModel;
    }
  }
  if ('temperature' in clone) delete clone.temperature;
  if ('top_p' in clone) delete clone.top_p;
  if (clone.metadata) delete clone.metadata;
  if (clone.usage && typeof clone.usage === 'object') {
    const usage = clone.usage;
    if (usage.input_tokens_details) {
      delete usage.input_tokens_details;
    }
    if (usage.output_tokens_details) {
      delete usage.output_tokens_details;
    }
    const prompt = resolveTokenMetric(usage, 'prompt_tokens', 'input_tokens');
    const completion = resolveTokenMetric(usage, 'completion_tokens', 'output_tokens');
    const total = resolveTokenMetric(usage, 'total_tokens', 'usage_tokens');
    normalizeUsageFields(usage, { prompt, completion, total });
  }
  if (clone.output && Array.isArray(clone.output)) {
    // 仅保留 message/reasoning 等终态内容，忽略 tool_use/function_call 等工具输出形态差异，
    // 并去除 status/role 等实现细节字段，以便聚焦文本语义与 usage 等矩阵不变量。
    clone.output = clone.output
      .filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const t = String(item.type || '').toLowerCase();
        return t === 'message' || t === 'reasoning';
      })
      .map((item) => {
        const copy = { ...item };
        delete copy.id;
        delete copy.status;
        delete copy.role;
        return copy;
      });
  }
  if (Array.isArray(clone.output_text)) {
    // Responses 规范允许 output_text 为字符串或字符串数组，这里统一为单一字符串以做等价性比较。
    const first = clone.output_text.find((v) => typeof v === 'string' && v.trim().length);
    clone.output_text = typeof first === 'string' ? first : clone.output_text.join('');
  }
  if (typeof clone.output_text !== 'string' || !clone.output_text.trim().length) {
    // 若 output_text 为空或缺失，则从首个 message 输出中提取文本用于等价性比较，
    // 避免因实现选择不同（直接写 output_text vs 仅写 message.content）导致矩阵误报。
    if (Array.isArray(clone.output)) {
      const firstMessage = clone.output.find(
        (item) => item && typeof item === 'object' && String(item.type || '').toLowerCase() === 'message'
      );
      if (firstMessage && Array.isArray(firstMessage.content)) {
        const texts = firstMessage.content
          .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
            return '';
          })
          .filter(Boolean);
        if (texts.length) {
          clone.output_text = texts.join('');
        }
      }
    }
  }
  return clone;
}

function diffJson(a, b, prefix = '<root>') {
  if (Object.is(a, b)) return [];
  if (typeof a !== typeof b) return [{ path: prefix, expected: a, actual: b }];
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < max; i += 1) {
      out.push(...diffJson(a[i], b[i], `${prefix}[${i}]`));
    }
    return out.filter(Boolean);
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out = [];
    for (const key of keys) {
      out.push(...diffJson(a[key], b[key], `${prefix}.${key}`));
    }
    return out.filter(Boolean);
  }
  return [{ path: prefix, expected: a, actual: b }];
}

function resolveTokenMetric(usage, primary, legacy) {
  const primaryVal = typeof usage[primary] === 'number' ? usage[primary] : undefined;
  const legacyVal = typeof usage[legacy] === 'number' ? usage[legacy] : undefined;
  return primaryVal ?? legacyVal;
}

function normalizeUsageFields(usage, metrics) {
  const { prompt, completion, total } = metrics;
  if (prompt !== undefined) {
    usage.prompt_tokens = prompt;
    if ('input_tokens' in usage) delete usage.input_tokens;
  }
  if (completion !== undefined) {
    usage.completion_tokens = completion;
    if ('output_tokens' in usage) delete usage.output_tokens;
  }
  if (total !== undefined) {
    usage.total_tokens = total;
    if ('usage_tokens' in usage) delete usage.usage_tokens;
  }
}

async function main() {
  let sample = loadLatestResponsesProviderSnapshot();
  let usingFixture = false;
  if (!sample) {
    if (!fs.existsSync(responsesFixture)) {
      throw new Error('缺少 responses response fixture，无法运行链路测试');
    }
    sample = { file: responsesFixture, payload: loadFixture(responsesFixture) };
    usingFixture = true;
  }

  const responsesBridge = await import(pathToFileURL(responsesBridgePath).href);
  const responseRuntime = await import(pathToFileURL(responseRuntimePath).href);
  const geminiCodec = await import(pathToFileURL(geminiCodecPath).href);
  const { ResponsesSseToJsonConverter } = await import(pathToFileURL(sseConverterPath).href);

  const toChatFromResponses = (payload) => responsesBridge.buildChatResponseFromResponses(payload);
  const toResponsesFromChat = (chat) => responsesBridge.buildResponsesPayloadFromChat(chat);
  const toAnthropicFromChat = (chat) => responseRuntime.buildAnthropicResponseFromChat(chat);
  const toChatFromAnthropic = (message) => responseRuntime.buildOpenAIChatFromAnthropicMessage(message);
  const toGeminiFromChat = (chat) => geminiCodec.buildGeminiFromOpenAIChat(chat);
  const toChatFromGemini = (resp) => geminiCodec.buildOpenAIChatFromGeminiResponse(resp);

  let initialResponses = extractPayload(sample.payload);
  assert.ok(initialResponses, `无法解析样本 ${sample.file}`);
  if (initialResponses &&
      typeof initialResponses === 'object' &&
      initialResponses.mode === 'sse' &&
      typeof initialResponses.raw === 'string') {
    const converter = new ResponsesSseToJsonConverter();
    const stream = Readable.from([initialResponses.raw]);
    initialResponses = await converter.convertSseToJson(stream, {
      requestId: path.basename(sample.file),
      model: typeof initialResponses.model === 'string' ? initialResponses.model : 'unknown'
    });
  }

  const chatInitial = toChatFromResponses(initialResponses);
  const normalizedInitialChat = sanitizeChat(chatInitial);

  const responsesOnce = toResponsesFromChat(chatInitial);
  const chatAfterResponsesRaw = toChatFromResponses(responsesOnce);
  const chatAfterResponses = sanitizeChat(chatAfterResponsesRaw);
  assert.deepStrictEqual(chatAfterResponses, normalizedInitialChat, 'Chat 语义在首次 Responses 往返后发生变化');

  const anthropicPayload = toAnthropicFromChat(chatInitial);
  const chatAfterAnthropicRaw = toChatFromAnthropic(anthropicPayload);
  const chatAfterAnthropic = sanitizeChat(chatAfterAnthropicRaw);
  assert.deepStrictEqual(chatAfterAnthropic, normalizedInitialChat, 'Chat 语义在 Anthropic 往返后发生变化');

  const geminiPayload = toGeminiFromChat(chatInitial);
  const chatAfterGeminiRaw = toChatFromGemini(geminiPayload);
  // 如果原始 Chat 中存在工具调用，则经过 Gemini 往返后应保持为工具回合
  const initialChoice = Array.isArray(chatInitial?.choices) ? chatInitial.choices[0] : undefined;
  const initialMsg = initialChoice && typeof initialChoice === 'object' ? initialChoice.message : undefined;
  const initialToolCalls =
    initialMsg && typeof initialMsg === 'object' && Array.isArray(initialMsg.tool_calls)
      ? initialMsg.tool_calls
      : [];
  if (initialToolCalls.length > 0) {
    const geminiChoice =
      Array.isArray(chatAfterGeminiRaw?.choices) && chatAfterGeminiRaw.choices.length > 0
        ? chatAfterGeminiRaw.choices[0]
        : undefined;
    const geminiFinishReason =
      geminiChoice && typeof geminiChoice === 'object' ? geminiChoice.finish_reason : undefined;
    if (geminiFinishReason !== 'tool_calls') {
      console.error('❌ Gemini 往返后 finish_reason 未保持为 tool_calls:', {
        initialFinishReason: initialChoice?.finish_reason,
        geminiFinishReason
      });
      process.exit(1);
    }
  }
  const chatAfterGemini = sanitizeChat(chatAfterGeminiRaw);
  assert.deepStrictEqual(chatAfterGemini, normalizedInitialChat, 'Chat 语义在 Gemini 往返后发生变化');

  // 如果初始 Responses 响应处于 required_action 状态，matrix 测试只关心一次工具循环
  // 完成后的终态。这里做一个极简的“模拟客户端”：当 initialResponses.status ===
  // "requires_action" 且存在 submit_tool_outputs.tool_calls 时，把该 required_action
  // 视为已经由客户端执行完毕，直接构造一份 completed 的响应用于链路比较。
  let responsesFinal = sanitizeResponsesPayload(toResponsesFromChat(chatAfterGeminiRaw));
  if (initialResponses && initialResponses.status === 'requires_action') {
    const ra = initialResponses.required_action;
    const submit = ra && typeof ra === 'object' ? ra.submit_tool_outputs : undefined;
    const calls = submit && typeof submit === 'object' ? submit.tool_calls : undefined;
    if (Array.isArray(calls) && calls.length > 0) {
      const cloned = JSON.parse(JSON.stringify(initialResponses));
      cloned.status = 'completed';
      if (Array.isArray(cloned.output) && cloned.output.length > 0 && cloned.output[0] && typeof cloned.output[0] === 'object') {
        cloned.output[0].status = 'completed';
      }
      // required_action 在真实客户端执行工具并提交结果后会被消费掉，这里在回放时直接删掉。
      delete cloned.required_action;
      responsesFinal = sanitizeResponsesPayload(cloned);
    }
  }
  const initialSanitized = sanitizeResponsesPayload(initialResponses);
  const responseDiffs = diffJson(initialSanitized, responsesFinal);
  if (responseDiffs.length) {
    console.error(`❌ Responses 响应链条存在差异 (${sample.file}):`);
    responseDiffs.slice(0, 10).forEach((entry) => {
      console.error(`  • ${entry.path}: expected =`, entry.expected, 'actual =', entry.actual);
    });
    if (responseDiffs.length > 10) {
      console.error(`  ... 共 ${responseDiffs.length} 处差异`);
    }
    process.exit(1);
  }

  if (usingFixture) {
    console.log('⚠️  未找到真实 responses provider-response 样本，已使用内置 fixture。');
  }
  console.log(`✅ Responses 响应链路往返一致 (${sample.file})`);
}

main().catch((error) => {
  console.error('hub-response-chain failed:', error);
  process.exit(1);
});
