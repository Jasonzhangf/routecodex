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
    'req_inbound',
    'req_inbound_stage1_format_parse',
    'index.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeAdapterContext() {
  return {
    requestId: 'req_inbound_format_parse_cov',
    providerProtocol: 'openai-chat'
  };
}

async function main() {
  const mod = await importFresh('hub-req-inbound-format-parse');
  const { runReqInboundStage1FormatParse } = mod;
  assert.equal(typeof runReqInboundStage1FormatParse, 'function');

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { messages: [{ role: 'user', content: 'hello' }], metadata: { trace: 1 } },
      adapterContext: makeAdapterContext(),
      stageRecorder: {
        record() {
          return undefined;
        }
      }
    });
    assert.equal(parsed.protocol, 'openai-chat');
    assert.equal(parsed.direction, 'request');
    assert.equal(Array.isArray(parsed.payload.messages), true);
    assert.deepEqual(parsed.payload.metadata, { trace: 1 });
  }

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { input: [{ role: 'user', content: 'hello responses' }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: ' OPENAI-RESPONSES ' }
    });
    assert.equal(parsed.protocol, 'openai-responses');
    assert.equal(parsed.direction, 'request');
  }

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { messages: [{ role: 'user', content: 'hello anthropic' }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: 'anthropic-messages' }
    });
    assert.equal(parsed.protocol, 'anthropic-messages');
    assert.equal(parsed.direction, 'request');
  }

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: 'gemini-chat' }
    });
    assert.equal(parsed.protocol, 'gemini-chat');
    assert.equal(parsed.direction, 'request');
  }

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { messages: [{ role: 'user', content: 'fallback unknown protocol' }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: 'unknown-protocol' }
    });
    assert.equal(parsed.protocol, 'openai-chat');
  }

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { messages: [{ role: 'user', content: 'fallback non-string protocol' }] },
      adapterContext: { ...makeAdapterContext(), providerProtocol: /** @type {any} */ (123) }
    });
    assert.equal(parsed.protocol, 'openai-chat');
  }

  {
    const parsed = await runReqInboundStage1FormatParse({
      rawRequest: { messages: 'invalid' },
      adapterContext: makeAdapterContext()
    });
    assert.equal(parsed.protocol, 'openai-chat');
    assert.equal(parsed.direction, 'request');
    assert.equal(parsed.payload.messages, 'invalid');
  }

  console.log('✅ coverage-hub-req-inbound-format-parse passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-inbound-format-parse failed:', error);
  process.exit(1);
});
