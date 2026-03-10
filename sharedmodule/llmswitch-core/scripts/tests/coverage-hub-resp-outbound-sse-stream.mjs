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
    'resp_outbound_stage2_sse_stream',
    'index.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function streamToText(stream) {
  let out = '';
  for await (const chunk of stream) {
    out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  }
  return out;
}

async function main() {
  const mod = await importFresh('hub-resp-outbound-sse-stream');
  const { runRespOutboundStage2SseStream } = mod;
  assert.equal(typeof runRespOutboundStage2SseStream, 'function');

  {
    const result = await runRespOutboundStage2SseStream({
      clientPayload: { id: 'resp_1' },
      clientProtocol: 'openai-chat',
      requestId: 'resp_outbound_sse_cov_1',
      wantsStream: false,
      stageRecorder: {
        record() {
          return undefined;
        }
      }
    });
    assert.deepEqual(result.body, { id: 'resp_1' });
    assert.equal(result.stream, undefined);
  }

  {
    const result = await runRespOutboundStage2SseStream({
      clientPayload: {
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      },
      clientProtocol: 'openai-chat',
      requestId: 'resp_outbound_sse_cov_2',
      wantsStream: true
    });
    assert.equal(result.body, undefined);
    assert.ok(result.stream);
    const text = await streamToText(result.stream);
    assert.ok(text.includes('data:'));
  }

  console.log('✅ coverage-hub-resp-outbound-sse-stream passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-outbound-sse-stream failed:', error);
  process.exit(1);
});
