#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runReqOutboundStage3CompatWithNative } from '../../dist/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

function applyRequestCompat(profile, payload, options = {}) {
  const adapterContext = options?.adapterContext && typeof options.adapterContext === 'object'
    ? options.adapterContext
    : {};
  return runReqOutboundStage3CompatWithNative({
    payload,
    explicitProfile: profile,
    adapterContext
  });
}

function countInlineBase64Media(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  let hits = 0;
  for (const message of rows) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
      if (!type.includes('image') && !type.includes('video')) continue;

      const pushValue = (value) => {
        if (typeof value !== 'string') return;
        const v = value.trim().toLowerCase();
        if ((v.startsWith('data:') && v.includes(';base64,')) || v.startsWith('base64,')) {
          hits += 1;
        }
      };

      pushValue(part.image_url);
      pushValue(part.video_url);
      pushValue(part.url);
      pushValue(part.uri);
      pushValue(part.data);
      if (part.image_url && typeof part.image_url === 'object') {
        pushValue(part.image_url.url);
        pushValue(part.image_url.data);
      }
      if (part.video_url && typeof part.video_url === 'object') {
        pushValue(part.video_url.url);
        pushValue(part.video_url.data);
      }
    }
  }
  return hits;
}

async function main() {
  const payload = {
    model: 'kimi-k2.5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'older turn' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_video', video_url: 'data:video/mp4;base64,BBB' }
        ]
      },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'latest turn' },
          { type: 'input_image', image_url: 'data:image/png;base64,CCC' }
        ]
      }
    ]
  };

  const before = countInlineBase64Media(payload.messages);
  assert.ok(before >= 3, 'fixture must include historical+latest inline media');

  const out = applyRequestCompat('chat:iflow', payload, { adapterContext: { providerProtocol: 'openai-chat' } }).payload;
  assert.ok(Array.isArray(out.messages), 'compat output must keep messages');

  const historicalUser = out.messages[0];
  const latestUser = out.messages[2];
  assert.ok(Array.isArray(historicalUser.content), 'historical user content must remain array');
  assert.ok(
    historicalUser.content.some((part) => part && typeof part === 'object' && part.type === 'text' && /history_(image|video)_base64_omitted/.test(part.text || '')),
    'historical media should be replaced by text placeholders'
  );
  assert.ok(Array.isArray(latestUser.content), 'latest user content must remain array');
  assert.ok(
    latestUser.content.some((part) => part && typeof part === 'object' && part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.startsWith('data:image/')),
    'latest user media must stay unchanged'
  );

  const after = countInlineBase64Media(out.messages);
  assert.equal(after, 1, 'only latest user turn media should keep inline base64');

  const controlPayload = {
    ...payload,
    model: 'qwen3-vl-plus'
  };
  const control = applyRequestCompat('chat:iflow', controlPayload, { adapterContext: { providerProtocol: 'openai-chat' } }).payload;
  const controlCount = countInlineBase64Media(control.messages);
  assert.equal(controlCount, before, 'non-kimi model should not be rewritten');

  console.log('[matrix:compat-iflow-kimi-history-media-placeholder] ok');
}

main().catch((err) => {
  console.error('[matrix:compat-iflow-kimi-history-media-placeholder] failed', err);
  process.exit(1);
});
