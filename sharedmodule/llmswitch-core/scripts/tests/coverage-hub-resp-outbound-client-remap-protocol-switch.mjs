#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'resp_outbound',
    'resp_outbound_stage1_client_remap',
    'client-remap-protocol-switch.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeChatPayload() {
  return {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'hello'
        }
      }
    ]
  };
}

async function main() {
  const mod = await importFresh('hub-resp-outbound-client-remap-protocol-switch');
  const { buildClientPayloadForProtocol } = mod;
  assert.equal(typeof buildClientPayloadForProtocol, 'function');

  {
    const payload = makeChatPayload();
    const out = buildClientPayloadForProtocol({
      payload,
      clientProtocol: 'openai-chat',
      requestId: 'req_chat_1'
    });
    assert.equal(out, payload);
  }

  {
    const payload = makeChatPayload();
    payload.metadata = { from: 'chat' };
    payload.temperature = 0.2;
    payload.top_p = 0.8;
    payload.prompt_cache_key = 'pcache';
    payload.reasoning = { effort: 'high' };
    payload.error = { code: 'upstream_error', message: 'bad' };

    const out = buildClientPayloadForProtocol({
      payload,
      clientProtocol: 'openai-responses',
      requestId: 'req_resp_1',
      requestSemantics: {
        tools: {
          clientToolsRaw: [{ type: 'function', name: 'exec_command', description: 'Run command' }]
        }
      }
    });
    assert.equal(out.object, 'response');
    assert.deepEqual(out.metadata, { from: 'chat' });
    assert.equal(out.temperature, 0.2);
    assert.equal(out.top_p, 0.8);
    assert.equal(out.prompt_cache_key, 'pcache');
    assert.deepEqual(out.reasoning, { effort: 'high' });
    assert.deepEqual(out.error, { code: 'upstream_error', message: 'bad' });
  }

  {
    const payload = makeChatPayload();
    payload.error = 'non-object-error';
    const out = buildClientPayloadForProtocol({
      payload,
      clientProtocol: 'anthropic-messages',
      requestId: 'req_ant_1',
      requestSemantics: {
        tools: {
          toolNameAliasMap: {
            shell_command: 'Bash'
          }
        }
      }
    });
    assert.ok(out && typeof out === 'object' && !Array.isArray(out));
    assert.equal(out.error, undefined);
  }

  {
    const payload = /** @type {any} */ ([]);
    const out = buildClientPayloadForProtocol({
      payload,
      clientProtocol: 'openai-responses',
      requestId: 'req_resp_array'
    });
    assert.equal(out.object, 'response');
  }

  {
    const payload = makeChatPayload();
    Object.defineProperty(payload, 'error', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('boom');
      }
    });
    assert.throws(
      () =>
        buildClientPayloadForProtocol({
          payload,
          clientProtocol: 'openai-chat',
          requestId: 'req_chat_throw_error'
        }),
      /native applyClientPassthroughPatchJson is required but unavailable/i
    );
  }

  console.log('✅ coverage-hub-resp-outbound-client-remap-protocol-switch passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-outbound-client-remap-protocol-switch failed:', error);
  process.exit(1);
});
