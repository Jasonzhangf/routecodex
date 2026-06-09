#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    normalizeMessageContentParts
  } = await import('../../dist/conversion/shared/output-content-normalizer.js');

  {
    const collector = ['seed'];
    const normalized = normalizeMessageContentParts(
      [
        { type: 'output_text', text: '<think>r1</think>first' },
        { type: 'text', text: 'second' }
      ],
      collector
    );
    assert.equal(Array.isArray(normalized.normalizedParts), true);
    assert.deepStrictEqual(normalized.reasoningChunks, ['seed', 'r1']);
    assert.deepStrictEqual(collector, ['seed', 'r1']);
    assert.equal(normalized.normalizedParts[0].text, 'first');
    assert.equal(normalized.normalizedParts[1].text, 'second');
  }

  console.log('✅ coverage-output-content-normalizer passed');
}

main().catch((error) => {
  console.error('❌ coverage-output-content-normalizer failed:', error);
  process.exit(1);
});
