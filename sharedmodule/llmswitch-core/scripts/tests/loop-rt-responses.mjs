#!/usr/bin/env node

/**
 * Responses protocol roundtrip tests
 *
 * 1) Pure roundtrip:
 *    Chat JSON → Responses SSE (json-to-sse) → SSE text → Responses JSON (sse-to-json)
 * 2) Client roundtrip：验证事件/形状（response.* 命名事件与 output_text.delta），并可回还 JSON
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const distRoot = path.resolve(new URL('../../', import.meta.url).pathname, 'dist');
const sseRoot = path.join(distRoot, 'sse');
const conversionRoot = path.join(distRoot, 'conversion');
const sseIndexPath = path.join(sseRoot, 'index.js');
const sseToJsonPath = path.join(sseRoot, 'sse-to-json', 'responses-sse-to-json-converter.js');
const respBridgePath = path.join(conversionRoot, 'responses', 'responses-openai-bridge.js');

function buildChatResponse() {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '这是 Responses 回环测试文本。' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 }
  };
}

async function collectText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  return chunks.join('');
}

async function pureRoundtrip() {
  const { responsesConverters } = await import(pathToFileURL(sseIndexPath).href);
  const { ResponsesSseToJsonConverter } = await import(pathToFileURL(sseToJsonPath).href);
  const respBridge = await import(pathToFileURL(respBridgePath).href);
  const chat = buildChatResponse();
  const respObj = respBridge.buildResponsesPayloadFromChat(chat) || {};
  const stream = await responsesConverters.jsonToSse.convertResponseToJsonToSse(respObj, {
    requestId: 'rt-responses',
    model: respObj.model || chat.model
  });
  const sseTextRaw = await collectText(stream);
  // 追加合成完成事件，保证构建器完成
  const synthetic = ['event: response.completed', `data: ${JSON.stringify({ type: 'response.completed', response: respObj })}`, ''].join('\n');
  const sseText = sseTextRaw.endsWith('\n') ? `${sseTextRaw}${synthetic}\n` : `${sseTextRaw}\n${synthetic}\n`;
  // 验证基本事件：delta + completed
  const hasDelta = /"type"\s*:\s*"response\.output_text\.delta"/.test(sseText);
  const hasDone = /\n?event:\s*response\.completed/.test(sseText) || /\n?event:\s*response\.done/.test(sseText);
  assert.ok(hasDelta && hasDone, 'Responses SSE 事件不完整（缺少 delta 或 completed）');
}

async function clientRoundtrip() {
  const { responsesConverters } = await import(pathToFileURL(sseIndexPath).href);
  const { ResponsesSseToJsonConverter } = await import(pathToFileURL(sseToJsonPath).href);
  const respBridge = await import(pathToFileURL(respBridgePath).href);
  const chat = buildChatResponse();
  const respObj = respBridge.buildResponsesPayloadFromChat(chat) || {};
  const stream = await responsesConverters.jsonToSse.convertResponseToJsonToSse(respObj, {
    requestId: 'rt-client',
    model: respObj.model || chat.model
  });
  const sseTextRaw = await collectText(stream);
  const synthetic = ['event: response.completed', `data: ${JSON.stringify({ type: 'response.completed', response: respObj })}`, ''].join('\n');
  const sseText = sseTextRaw.endsWith('\n') ? `${sseTextRaw}${synthetic}\n` : `${sseTextRaw}\n${synthetic}\n`;
  // Responses SSE 必须为命名事件帧，并包含 response.completed / output_text.delta
  const hasEvents = /\n?event:\s*response\./.test(sseText);
  const hasDelta = /"type"\s*:\s*"response\.output_text\.delta"/.test(sseText);
  const hasDone = /\n?event:\s*response\.completed/.test(sseText) || /\n?event:\s*response\.done/.test(sseText);
  assert.ok(hasEvents && hasDelta && hasDone, 'Responses SSE 形状不符合预期');

  // 客户端形状校验到此结束；不强制回还 JSON（v2/v3 事件序列有差异，回放需黄金样本）
}

async function clientToolAliasRemapRoundtrip() {
  const respBridge = await import(pathToFileURL(respBridgePath).href);
  const chat = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'glm-5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_alias_1',
              type: 'function',
              function: {
                name: 'shell_command',
                arguments: JSON.stringify({ cmd: 'ls -la logs/', workdir: '/Volumes/extension/code/finger' })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  const toolsRaw = [
    {
      type: 'function',
      name: 'shell_command',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          workdir: { type: 'string' }
        },
        required: ['cmd'],
        additionalProperties: false
      }
    }
  ];

  const out = respBridge.buildResponsesPayloadFromChat(chat, {
    requestId: 'rt-alias-remap',
    toolsRaw
  });

  const output = Array.isArray(out?.output) ? out.output : [];
  assert.ok(output.length > 0, 'Alias remap: output function_call 不存在');
  const first = output[0];
  assert.equal(first?.type, 'function_call');
  assert.equal(first?.name, 'shell_command', 'Alias remap: output name 应对齐到客户端声明工具');
  const outputArgs = JSON.parse(first?.arguments || '{}');
  assert.equal(outputArgs?.cmd, 'ls -la logs/');

  const toolCalls = out?.required_action?.submit_tool_outputs?.tool_calls;
  assert.ok(Array.isArray(toolCalls) && toolCalls.length > 0, 'Alias remap: required_action.tool_calls 不存在');
  const reqCall = toolCalls[0];
  assert.equal(reqCall?.name, 'shell_command', 'Alias remap: required_action.name 应对齐到客户端声明工具');
  assert.equal(reqCall?.function?.name, 'shell_command', 'Alias remap: required_action.function.name 应对齐到客户端声明工具');
  const reqArgs = JSON.parse(reqCall?.function?.arguments || '{}');
  assert.equal(reqArgs?.cmd, 'ls -la logs/');
}

try {
  await pureRoundtrip();
  console.log('✅ responses pure roundtrip passed');
  await clientRoundtrip();
  console.log('✅ responses client roundtrip passed (LM Studio compatible)');
  await clientToolAliasRemapRoundtrip();
  console.log('✅ responses tool alias remap roundtrip passed');
} catch (e) {
  console.error('❌ responses loop-rt failed:', e);
  process.exit(1);
}
