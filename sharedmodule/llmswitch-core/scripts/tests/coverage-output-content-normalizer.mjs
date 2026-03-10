#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    extractOutputSegments,
    normalizeContentPart,
    normalizeMessageContentParts
  } = await import('../../dist/conversion/shared/output-content-normalizer.js');

  {
    const output = extractOutputSegments({
      output: [
        { type: 'output_text', text: 'hello' },
        { type: 'reasoning', content: [{ text: '<think>hidden</think>plan' }] },
        { type: 'message', content: [{ type: 'text', text: 'world' }] }
      ]
    });
    assert.deepStrictEqual(output.textParts, ['hello', 'world']);
    assert.deepStrictEqual(output.reasoningParts, ['plan']);
  }

  {
    const collector = [];
    const normalized = normalizeContentPart('<think>internal</think>visible', collector);
    assert.deepStrictEqual(normalized, { type: 'output_text', text: 'visible' });
    assert.deepStrictEqual(collector, ['internal']);
  }

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
