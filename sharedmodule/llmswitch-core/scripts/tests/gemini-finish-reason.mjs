#!/usr/bin/env node
/**
 * Gemini inbound → Chat mapping finish_reason invariant
 *
 * - Build a synthetic Gemini response with functionCall (tool call)
 * - Map via buildOpenAIChatFromGeminiResponse(...)
 * - Run ResponseFinishInvariantsFilter
 * - Assert:
 *   - tool_calls preserved
 *   - finish_reason === 'tool_calls'
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const geminiCodecMod = await import(path.join(projectRoot, 'dist', 'conversion', 'codecs', 'gemini-openai-codec.js'));
const filtersMod = await import(path.join(projectRoot, 'dist', 'filters', 'index.js'));

const { buildOpenAIChatFromGeminiResponse } = geminiCodecMod;
const { ResponseFinishInvariantsFilter } = filtersMod;

const GEMINI_TOOL_RESP = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          { text: 'I will perform a search.' },
          {
            functionCall: {
              name: 'search_docs',
              args: { query: 'codex latest news' }
            }
          }
        ]
      },
      finishReason: 'STOP'
    }
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 20,
    totalTokenCount: 30
  },
  modelVersion: 'gemini-3-pro-low'
};

function applyFinishInvariants(chat) {
  const filter = new ResponseFinishInvariantsFilter();
  const res = filter.apply(chat);
  if (!res.ok) {
    throw new Error('ResponseFinishInvariantsFilter failed');
  }
  return res.data;
}

async function main() {
  const chat = buildOpenAIChatFromGeminiResponse(GEMINI_TOOL_RESP);
  const governed = applyFinishInvariants(chat);

  const choice = Array.isArray(governed?.choices) ? governed.choices[0] : undefined;
  assert.ok(choice && typeof choice === 'object', 'Chat response must contain a choice');

  const msg = choice.message;
  assert.ok(msg && typeof msg === 'object', 'Choice must contain a message');

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  assert.ok(toolCalls.length > 0, 'Gemini tool_call should be preserved as message.tool_calls');

  assert.strictEqual(
    choice.finish_reason,
    'tool_calls',
    `finish_reason must be "tool_calls" when tool_calls are present (got ${choice.finish_reason})`
  );

  console.log('✅ Gemini inbound finish_reason invariant passed');
}

main().catch((err) => {
  console.error('❌ gemini-finish-reason test failed:', err);
  process.exit(1);
});

