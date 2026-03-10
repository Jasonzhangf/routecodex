#!/usr/bin/env node

/**
 * Chat protocol roundtrip tests
 *
 * 1) Pure roundtrip:
 *    chat JSON → SSEOutputNode → SSE text → SSEInputNode → chat JSON
 * 2) Client roundtrip (LM Studio compatible):
 *    验证 SSE 文本为 OpenAI Chat 形状（无命名事件，包含 data 帧），并可回还为 JSON
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const { createChatConverters } = await import('../../dist/sse/index.js');
const chatConverters = createChatConverters();

function buildChatResponse() {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '你好，我是回环测试机器人。'
        },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 }
  };
}

async function collectText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  return chunks.join('');
}

async function pureRoundtrip() {
  const chat = buildChatResponse();
  const sseStream = await chatConverters.jsonToSse.convertResponseToJsonToSse(chat, {
    requestId: 'req-rt-chat',
    model: chat.model
  });
  const sseText1 = await collectText(sseStream);
  assert.ok(/\n?data:\s*\{/.test(sseText1), 'SSE 文本应包含 data 帧');

  const round = await chatConverters.sseToJson.convertSseToJson(Readable.from([sseText1]), {
    requestId: 'req-rt-chat',
    model: chat.model
  });
  assert.strictEqual(round?.model, chat.model, '模型不一致');
  const originalText = chat.choices?.[0]?.message?.content;
  const roundText = round?.choices?.[0]?.message?.content;
  assert.ok(typeof roundText === 'string' && roundText.length, '回环文本缺失');
}

async function clientRoundtrip() {
  const chat = buildChatResponse();
  const sseStream = await chatConverters.jsonToSse.convertResponseToJsonToSse(chat, {
    requestId: 'req-rt-client',
    model: chat.model
  });
  const sseText = await collectText(sseStream);

  // LM Studio-compatible: OpenAI Chat SSE：无命名事件、必须有 data 帧
  const hasDataLine = /\n?data:\s*\{/.test(sseText);
  const hasResponsesEvent = /\n?event:\s*response\./.test(sseText);
  assert.ok(hasDataLine && !hasResponsesEvent, 'SSE 形状不符合 OpenAI Chat 预期（必须包含 data 帧且不含 response.* 命名事件）');

  // 再回到 JSON 验证可读
  const parsed = await chatConverters.sseToJson.convertSseToJson(Readable.from([sseText]), {
    requestId: 'req-rt-client',
    model: chat.model
  });
  assert.strictEqual(parsed?.model, chat.model, '客户端回环 JSON 解析失败');
}

try {
  await pureRoundtrip();
  console.log('✅ chat pure roundtrip passed');
  await clientRoundtrip();
  console.log('✅ chat client roundtrip passed (LM Studio compatible)');
} catch (e) {
  console.error('❌ chat loop-rt failed:', e);
  process.exit(1);
}
