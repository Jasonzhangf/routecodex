#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const { convertProviderResponse } = await import(
    path.resolve(repoRoot, 'dist/conversion/hub/response/provider-response.js')
  );

  let reenterCalled = 0;
  const reenterPipeline = async () => {
    reenterCalled += 1;
    throw new Error('reenterPipeline should not be called on serverToolFollowup hops');
  };

  const context = {
    requestId: 'req_servertool_followup_skip_1',
    sessionId: 'sess_servertool_followup_skip_1',
    providerKey: 'test.provider',
    __rt: {
      serverToolFollowup: true
    }
  };

  const providerResponse = {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_clock_1',
              type: 'function',
              function: { name: 'clock', arguments: JSON.stringify({ action: 'list' }) }
            }
          ]
        }
      }
    ]
  };

  const result = await convertProviderResponse({
    providerProtocol: 'openai-chat',
    providerResponse,
    context,
    entryEndpoint: '/v1/chat/completions',
    wantsStream: false,
    requestSemantics: {},
    providerInvoker: undefined,
    stageRecorder: undefined,
    reenterPipeline
  });

  assert.equal(reenterCalled, 0, 'serverToolFollowup hop must skip servertool orchestration');
  assert.ok(result && typeof result === 'object', 'convertProviderResponse must return an object');
  assert.ok(result.body && typeof result.body === 'object', 'result.body must exist');

  const body = result.body;
  assert.equal(body.object, 'chat.completion', 'followup hop must return openai-chat-like payload');
  assert.ok(Array.isArray(body.choices) && body.choices.length === 1, 'choices must be preserved');

  const msg = body.choices[0]?.message;
  assert.ok(msg && typeof msg === 'object', 'message must exist');
  assert.ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, 'tool_calls must be preserved');
  assert.equal(msg.tool_calls[0]?.function?.name, 'clock');

  console.log('[servertool-followup-skip] tests passed');
}

main().catch((e) => {
  console.error('❌ [servertool-followup-skip] failed', e);
  process.exit(1);
});

