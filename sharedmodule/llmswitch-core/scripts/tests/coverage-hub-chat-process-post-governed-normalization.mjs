#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-post-governed-normalization.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeBaseRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

async function main() {
  const { applyPostGovernedNormalization } = await importFresh('hub-chat-process-post-governed-normalization');
  assert.equal(typeof applyPostGovernedNormalization, 'function');

  {
    const request = makeBaseRequest();
    request.metadata = undefined;
    request.messages = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'https://example.com/a.png' }
        ]
      }
    ];
    const out = await applyPostGovernedNormalization({
      request,
      metadata: {},
      originalEndpoint: '/v1/messages'
    });
    assert.equal(out.metadata.originalEndpoint, '/v1/messages');
    assert.equal(out.metadata.hasImageAttachment, true);
  }

  {
    const request = makeBaseRequest();
    request.metadata = undefined;
    request.messages = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'fallback endpoint' },
          { type: 'input_image', image_url: 'https://example.com/fallback.png' }
        ]
      }
    ];
    const out = await applyPostGovernedNormalization({
      request,
      metadata: {}
    });
    assert.equal(out.metadata.originalEndpoint, '/v1/chat/completions');
    assert.equal(out.metadata.hasImageAttachment, true);
  }

  {
    const request = makeBaseRequest();
    request.messages = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'img1' },
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'img2' },
          { type: 'image_url', image_url: { url: 'https://example.com/2.png' } }
        ]
      }
    ];
    const out = await applyPostGovernedNormalization({
      request,
      metadata: {}
    });
    assert.equal(out.metadata.hasImageAttachment, true);
    assert.equal(Array.isArray(out.messages[0].content), true);
    assert.equal(out.messages[0].content[1].type, 'text');
    assert.equal(out.messages[0].content[1].text, '[Image omitted]');
  }

  {
    const request = makeBaseRequest();
    const out = await applyPostGovernedNormalization({
      request,
      metadata: {}
    });
    assert.equal(out.metadata.hasImageAttachment, undefined);
  }

  console.log('✅ coverage-hub-chat-process-post-governed-normalization passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-post-governed-normalization failed:', error);
  process.exit(1);
});
