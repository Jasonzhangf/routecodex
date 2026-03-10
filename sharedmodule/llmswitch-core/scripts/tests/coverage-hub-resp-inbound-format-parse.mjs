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
    'resp_inbound',
    'resp_inbound_stage2_format_parse',
    'index.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeAdapterContext() {
  return {
    requestId: 'resp_inbound_format_parse_cov',
    providerProtocol: 'openai-chat'
  };
}

async function main() {
  const mod = await importFresh('hub-resp-inbound-format-parse');
  const { runRespInboundStage2FormatParse } = mod;
  assert.equal(typeof runRespInboundStage2FormatParse, 'function');

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { id: 'resp_1', choices: [{ message: { role: 'assistant', content: 'ok' } }], metadata: { trace: 2 } },
      adapterContext: makeAdapterContext(),
      stageRecorder: {
        record() {
          return undefined;
        }
      }
    });
    assert.equal(parsed.protocol, 'openai-chat');
    assert.equal(parsed.direction, 'response');
    assert.equal(Array.isArray(parsed.payload.choices), true);
    assert.deepEqual(parsed.payload.metadata, { trace: 2 });
  }

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { id: 'resp_2' },
      adapterContext: makeAdapterContext()
    });
    assert.equal(parsed.protocol, 'openai-chat');
    assert.equal(parsed.direction, 'response');
    assert.equal(parsed.payload.id, 'resp_2');
  }

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: ' OPENAI-RESPONSES ' }
    });
    assert.equal(parsed.protocol, 'openai-responses');
    assert.equal(parsed.direction, 'response');
  }

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { content: [{ type: 'text', text: 'anthropic' }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: 'anthropic-messages' }
    });
    assert.equal(parsed.protocol, 'anthropic-messages');
    assert.equal(parsed.direction, 'response');
  }

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { candidates: [{ content: { parts: [{ text: 'gemini' }] } }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: 'gemini-chat' }
    });
    assert.equal(parsed.protocol, 'gemini-chat');
    assert.equal(parsed.direction, 'response');
  }

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { choices: [{ message: { role: 'assistant', content: 'fallback unknown protocol' } }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: 'unknown-protocol' }
    });
    assert.equal(parsed.protocol, 'openai-chat');
    assert.equal(parsed.direction, 'response');
  }

  {
    const parsed = await runRespInboundStage2FormatParse({
      payload: { choices: [{ message: { role: 'assistant', content: 'fallback non-string protocol' } }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: /** @type {any} */ (123) }
    });
    assert.equal(parsed.protocol, 'openai-chat');
    assert.equal(parsed.direction, 'response');
  }

  console.log('✅ coverage-hub-resp-inbound-format-parse passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-inbound-format-parse failed:', error);
  process.exit(1);
});
