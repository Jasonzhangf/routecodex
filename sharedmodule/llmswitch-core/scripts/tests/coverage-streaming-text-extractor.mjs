#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { createStreamingToolExtractor } = await import('../../dist/conversion/shared/streaming-text-extractor.js');

  {
    const extractor = createStreamingToolExtractor({ idPrefix: 'stream' });
    const calls = extractor.feedText('<function=execute><parameter=command>pwd</parameter></function=execute>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function?.name, 'shell');
    assert.deepStrictEqual(JSON.parse(calls[0].function?.arguments ?? '{}'), { command: ['pwd'] });
    assert.match(calls[0].id ?? '', /^stream_/);
  }

  {
    const extractor = createStreamingToolExtractor({ idPrefix: 'patch' });
    const calls = extractor.feedText('```json\n{"changes":[{"kind":"add","file":"a.txt","content":"hi"}]}\n```');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function?.name, 'apply_patch');
  }

  {
    const extractor = createStreamingToolExtractor({ idPrefix: 'reset' });
    const first = extractor.feedText('<function=execute><parameter=command>echo hi</parameter></function=execute>');
    assert.equal(first.length, 1);
    extractor.reset();
    const second = extractor.feedText('<function=execute><parameter=command>pwd</parameter></function=execute>');
    assert.equal(second.length, 1);
    assert.match(second[0].id ?? '', /^reset_/);
  }

  console.log('✅ coverage-streaming-text-extractor passed');
}

main().catch((error) => {
  console.error('❌ coverage-streaming-text-extractor failed:', error);
  process.exit(1);
});
