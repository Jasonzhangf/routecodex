#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const standardizedBridgeUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'standardized-bridge.js')
).href;
const nativeReqInboundUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-hub-pipeline-req-inbound-semantics.js'
  )
).href;

function stableJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function importFresh(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const stdMod = await importFresh(standardizedBridgeUrl, 'std-bridge');
  const nativeMod = await importFresh(nativeReqInboundUrl, 'native-req-inbound');
  const chatEnvelopeToStandardized = stdMod.chatEnvelopeToStandardized;
  const chatEnvelopeToStandardizedWithNative = nativeMod.chatEnvelopeToStandardizedWithNative;

  assert.equal(typeof chatEnvelopeToStandardized, 'function');
  assert.equal(typeof chatEnvelopeToStandardizedWithNative, 'function');

  const adapterContext = {
    requestId: 'req_std_001',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    routeId: 'default/default-primary'
  };

  const sampleChat = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      },
      {
        role: 'assistant',
        content: 'processing',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'demo_tool',
              arguments: { x: 1 }
            }
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'demo_tool',
          description: 'demo',
          parameters: { type: 'object', properties: { x: { type: 'number' } } },
          strict: true
        }
      }
    ],
    parameters: {
      model: 'qwen3.5-plus',
      stream: true,
      temperature: 0.2
    },
    metadata: {
      context: adapterContext,
      missingFields: [{ path: 'messages[1].content', reason: 'compat' }],
      providerMetadata: { provider: 'qwen' },
      protocolState: { phase: 'chat' }
    },
    semantics: {
      tools: {
        enabled: true
      }
    }
  };

  const tsResult = chatEnvelopeToStandardized(sampleChat, {
    adapterContext,
    endpoint: adapterContext.entryEndpoint,
    requestId: adapterContext.requestId
  });

  const nativeResult = chatEnvelopeToStandardizedWithNative({
    chatEnvelope: sampleChat,
    adapterContext,
    endpoint: adapterContext.entryEndpoint,
    requestId: adapterContext.requestId
  });

  assert.deepEqual(stableJson(nativeResult), stableJson(tsResult));

  const chatWithoutTools = {
    messages: [{ role: 'user', content: 'plain text' }],
    parameters: { model: 'qwen3.5-plus', stream: false },
    metadata: { context: adapterContext }
  };

  const tsResult2 = chatEnvelopeToStandardized(chatWithoutTools, {
    adapterContext,
    endpoint: adapterContext.entryEndpoint,
    requestId: undefined
  });

  const nativeResult2 = chatEnvelopeToStandardizedWithNative({
    chatEnvelope: chatWithoutTools,
    adapterContext,
    endpoint: adapterContext.entryEndpoint
  });

  assert.deepEqual(stableJson(nativeResult2), stableJson(tsResult2));
  console.log('ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
