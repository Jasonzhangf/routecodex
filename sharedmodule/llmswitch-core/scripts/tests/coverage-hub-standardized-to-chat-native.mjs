#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const standardizedBridgeUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'standardized-bridge.js')
).href;
const nativeReqOutboundUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-hub-pipeline-req-outbound-semantics.js'
  )
).href;

function stableJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function importFresh(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const stdMod = await importFresh(standardizedBridgeUrl, 'std-to-chat');
  const nativeMod = await importFresh(nativeReqOutboundUrl, 'native-req-outbound');
  const standardizedToChatEnvelope = stdMod.standardizedToChatEnvelope;
  const standardizedToChatEnvelopeWithNative = nativeMod.standardizedToChatEnvelopeWithNative;

  assert.equal(typeof standardizedToChatEnvelope, 'function');
  assert.equal(typeof standardizedToChatEnvelopeWithNative, 'function');

  const adapterContext = {
    requestId: 'req_std_chat_001',
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    __rt: {
      keepFromContext: true
    },
    toolCallIdStyle: 'fc'
  };

  const standardized = {
    model: 'qwen3.5-plus',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'demo_tool',
              arguments: '{"x":1}'
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
      temperature: 0.3
    },
    metadata: {
      __rt: {
        keepFromMeta: true,
        forceVision: true
      },
      webSearch: { enabled: true },
      capturedContext: {
        __hub_capture: {
          missingFields: [{ path: 'messages[0].content', reason: 'compat' }],
          providerMetadata: { provider: 'qwen' },
          protocolState: { stage: 'outbound' }
        }
      }
    },
    semantics: {
      tools: { enabled: true }
    }
  };

  const tsResult = standardizedToChatEnvelope(standardized, { adapterContext });
  const nativeResult = standardizedToChatEnvelopeWithNative({
    request: standardized,
    adapterContext
  });

  assert.deepEqual(stableJson(nativeResult), stableJson(tsResult));

  const minimalStd = {
    model: 'qwen3.5-plus',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {},
    metadata: {}
  };
  const tsResult2 = standardizedToChatEnvelope(minimalStd, { adapterContext: { requestId: 'r2' } });
  const nativeResult2 = standardizedToChatEnvelopeWithNative({
    request: minimalStd,
    adapterContext: { requestId: 'r2' }
  });
  assert.deepEqual(stableJson(nativeResult2), stableJson(tsResult2));

  console.log('ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
