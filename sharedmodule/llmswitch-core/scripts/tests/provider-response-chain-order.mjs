#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const converterPath = path.join(projectRoot, 'dist', 'conversion', 'hub', 'response', 'provider-response.js');
const { convertProviderResponse } = await import(pathToFileURL(converterPath).href);

const chatResponse = {
  id: 'chatcmpl_chain_order',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'chain-order-check'
      }
    }
  ]
};

const context = {
  requestId: 'req_chain_order',
  entryEndpoint: '/v1/chat/completions',
  providerProtocol: 'openai-chat'
};

const stageOrder = [];
const stageRecorder = {
  record(stage) {
    stageOrder.push(String(stage));
  }
};

const converted = await convertProviderResponse({
  providerProtocol: 'openai-chat',
  providerResponse: chatResponse,
  context,
  entryEndpoint: '/v1/chat/completions',
  wantsStream: false,
  stageRecorder
});

assert.ok(converted && converted.body, 'provider response chain should produce client body');

const idxDecode = stageOrder.indexOf('chat_process.resp.stage1.sse_decode');
const idxCompat = stageOrder.indexOf('chat_process.resp.stage3.compat');
const idxFormatParse = stageOrder.indexOf('chat_process.resp.stage2.format_parse');
const idxSemanticMap = stageOrder.indexOf('chat_process.resp.stage4.semantic_map_to_chat');
const idxToolGovernance = stageOrder.indexOf('chat_process.resp.stage7.tool_governance');
const idxClientRemap = stageOrder.indexOf('chat_process.resp.stage9.client_remap');
const idxSseOut = stageOrder.indexOf('chat_process.resp.stage10.sse_stream');

for (const [name, idx] of [
  ['stage1.sse_decode', idxDecode],
  ['stage3.compat', idxCompat],
  ['stage2.format_parse', idxFormatParse],
  ['stage4.semantic_map_to_chat', idxSemanticMap],
  ['stage7.tool_governance', idxToolGovernance],
  ['stage9.client_remap', idxClientRemap],
  ['stage10.sse_stream', idxSseOut]
]) {
  assert.ok(idx >= 0, `missing stage record: ${name}`);
}

assert.ok(idxDecode < idxCompat, 'expected sse_decode before compat');
assert.ok(idxCompat < idxFormatParse, 'expected compat before inbound format_parse');
assert.ok(idxFormatParse < idxSemanticMap, 'expected inbound format_parse before semantic_map');
assert.ok(idxSemanticMap < idxToolGovernance, 'expected semantic_map before chat_process tool_governance');
assert.ok(idxToolGovernance < idxClientRemap, 'expected tool_governance before client_remap');
assert.ok(idxClientRemap < idxSseOut, 'expected client_remap before outbound sse_stream');

console.log('[matrix:provider-response-chain-order] ok');
