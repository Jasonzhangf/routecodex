#!/usr/bin/env node
import assert from 'node:assert/strict';

const { geminiConverters } = await import('../../dist/sse/index.js');

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
  await geminiSseRoundtrip();
} catch (e) {
  console.error('❌ loop-rt-gemini failed:', e);
  process.exit(1);
}
