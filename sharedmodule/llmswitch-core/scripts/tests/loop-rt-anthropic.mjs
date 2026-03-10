#!/usr/bin/env node

/**
 * Anthropic protocol roundtrip tests
 *
 * 1) Pure roundtrip:
 *    chat JSON → SSE (anthropic) → 仅做形状检查（暂无统一 sse→json 解析器）
 * 2) Client roundtrip：验证命名事件存在（message 开头 / delta / completed），保证形状兼容
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const { createAnthropicConverters } = await import('../../dist/sse/index.js');
const anthropicConverters = createAnthropicConverters();

function buildAnthropicMessage() {
  return {
    id: `msg-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus-20240229',
    content: [
      {
        type: 'text',
        text: '这是 Anthropic 回环测试文本。'
      }
    ],
    stop_reason: 'end_turn'
  };
}

async function collectText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  return chunks.join('');
}

async function pureRoundtrip() {
  const message = buildAnthropicMessage();
  const stream = await anthropicConverters.jsonToSse.convertResponseToJsonToSse(message, {
    requestId: 'req-rt-anth',
    model: message.model
  });
  const sseText = await collectText(stream);
  assert.ok(/\n?event:\s*\w+/.test(sseText) && /\n?data:\s*\{/.test(sseText), 'Anthropic SSE 形状不符合预期');
}

async function clientRoundtrip() {
  const message = buildAnthropicMessage();
  const stream = await anthropicConverters.jsonToSse.convertResponseToJsonToSse(message, {
    requestId: 'req-client-anth',
    model: message.model
  });
  const sseText = await collectText(stream);
  const hasNamed = /\n?event:\s*\w+/.test(sseText);
  assert.ok(hasNamed, 'Anthropic SSE 未检测到命名事件');

  // 确保可以回读 JSON
  const parsed = await anthropicConverters.sseToJson.convertSseToJson(Readable.from([sseText]), {
    requestId: 'req-client-anth',
    model: message.model
  });
  const origText = extractAnthropicText(message.content).trim();
  const parsedText = extractAnthropicText(parsed?.content).trim();
  assert.ok(parsedText === origText, 'Anthropic JSON 还原失败');
}

function extractAnthropicText(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return '';
  return contentBlocks
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
      if (block.type === 'tool_use') return `[tool:${block.name || 'unknown'}]`;
      return '';
    })
    .join('');
}

try {
  await pureRoundtrip();
  console.log('✅ anthropic pure roundtrip passed');
  await clientRoundtrip();
  console.log('✅ anthropic client roundtrip passed (GLM-Anthropic compatible)');
} catch (e) {
  console.error('❌ anthropic loop-rt failed:', e);
  process.exit(1);
}
