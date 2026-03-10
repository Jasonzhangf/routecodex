#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { createSseParser } = await import('../../dist/sse/sse-to-json/parsers/sse-parser.js');

  const parser = createSseParser({ enableStrictValidation: true, enableEventRecovery: false });

  {
    const payload = {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'item_1',
        type: 'message',
        role: 'assistant',
        content: []
      }
    };
    const result = parser.parseEvent(`data: ${JSON.stringify(payload)}\n`);
    assert.equal(result.success, true);
    assert.ok(result.event);
    assert.equal(result.event.type, 'response.output_item.added');
  }

  {
    const result = parser.parseEvent(`data: ${JSON.stringify({ type: 'not.a.real.event' })}\n`);
    assert.equal(result.success, false);
    assert.match(String(result.error || ''), /Invalid event type/);
  }

  console.log('✅ responses-sse-parser-lmstudio-no-event passed');
}

main().catch((e) => {
  console.error('❌ responses-sse-parser-lmstudio-no-event failed:', e);
  process.exit(1);
});

