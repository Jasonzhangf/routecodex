#!/usr/bin/env node
import assert from 'node:assert/strict';

const { geminiConverters } = await import('../../dist/sse/index.js');
const { runHubInboundConversion } = await import('../../dist/conversion/hub/node-support.js');

// Minimal Gemini request sample (generateContent) including an inline image block
const GEMINI_REQ = {
  model: 'gemini-1.5-flash',
  contents: [
    {
      role: 'user',
      parts: [
        { text: 'Say hello from Gemini and describe this image.' },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        }
      ]
    }
  ],
  generationConfig: { temperature: 0.7, maxOutputTokens: 128 }
};

const GEMINI_RESP = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          { text: 'Hello from Gemini SSE!' },
          { functionCall: { name: 'search_docs', args: { query: 'codex news' } } }
        ]
      },
      finishReason: 'STOP'
    }
  ],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 24,
    totalTokenCount: 36
  },
  promptFeedback: {
    safetyRatings: []
  },
  modelVersion: 'gemini-1.5-flash'
};

async function inboundConversionSmoke() {
  const inbound = await runHubInboundConversion({
    protocol: 'gemini-chat',
    rawRequest: GEMINI_REQ,
    nodeContext: {
      request: {
        id: 'rt-gemini-client',
        endpoint: '/v1beta/models:generateContent',
        context: {
          metadata: {
            providerProtocol: 'gemini-chat'
          }
        }
      }
    },
    nodeId: 'hub-inbound',
    inputFormat: '/v1beta/models:generateContent',
    outputFormat: 'standardized-request',
    startTime: Date.now()
  });
  assert.ok(inbound.success !== false && inbound.data?.standardizedRequest, '转换 Gemini 请求失败');
  console.log('✅ gemini inbound conversion passed');
}

async function geminiSseRoundtrip() {
  const sseStream = await geminiConverters.jsonToSse.convertResponseToJsonToSse(GEMINI_RESP, {
    requestId: 'rt-gemini',
    model: GEMINI_RESP.modelVersion
  });
  const json = await geminiConverters.sseToJson.convertSseToJson(sseStream, {
    requestId: 'rt-gemini-2',
    model: GEMINI_RESP.modelVersion
  });
  const originalText = GEMINI_RESP.candidates?.[0]?.content?.parts?.[0]?.text;
  const roundtripText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  assert.strictEqual(roundtripText, originalText, 'Gemini SSE text mismatch');
  const originalCall = GEMINI_RESP.candidates?.[0]?.content?.parts?.[1]?.functionCall?.name;
  const roundtripCall = json.candidates?.[0]?.content?.parts?.[1]?.functionCall?.name;
  assert.strictEqual(roundtripCall, originalCall, 'Gemini SSE function call mismatch');
  console.log('✅ gemini SSE roundtrip passed');
}

try {
  await inboundConversionSmoke();
  await geminiSseRoundtrip();
} catch (e) {
  console.error('❌ loop-rt-gemini failed:', e);
  process.exit(1);
}
