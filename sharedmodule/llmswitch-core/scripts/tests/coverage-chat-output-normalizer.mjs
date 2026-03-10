#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { normalizeChatMessageContent } = await import('../../dist/conversion/shared/chat-output-normalizer.js');

  {
    const normalized = normalizeChatMessageContent([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '<think>hidden</think>world' }
    ]);
    assert.equal(normalized.contentText, 'helloworld');
    assert.equal(normalized.reasoningText, 'hidden');
  }

  {
    const normalized = normalizeChatMessageContent('plain text');
    assert.equal(normalized.contentText, 'plain text');
    assert.equal(normalized.reasoningText, undefined);
  }

  console.log('✅ coverage-chat-output-normalizer passed');
}

main().catch((error) => {
  console.error('❌ coverage-chat-output-normalizer failed:', error);
  process.exit(1);
});
