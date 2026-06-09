#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    createToolCallIdTransformer,
    enforceToolCallIdStyle,
    stripInternalToolingMetadata,
    sanitizeResponsesFunctionName
  } = await import('../../dist/conversion/shared/responses-tool-utils.js');

  {
    const transformer = createToolCallIdTransformer('fc');
    assert.ok(transformer);
    const input = [
      { type: 'function_call', id: 'toolu_1', call_id: 'toolu_1' },
      { type: 'function_call_output', id: 'result_1', tool_call_id: 'toolu_1' }
    ];
    enforceToolCallIdStyle(input, transformer);

    assert.match(input[0].call_id, /^call_/);
    assert.match(input[0].id, /^fc_/);
    assert.match(input[1].call_id, /^call_/);
    assert.match(input[1].tool_call_id, /^call_/);
    assert.match(input[1].id, /^fc_/);
    assert.equal(createToolCallIdTransformer('preserve'), null);
  }

  {
    const metadata = {
      toolCallIdStyle: 'fc',
      __rcc_raw_system: 'internal',
      extraFields: {
        __rcc_private: true,
        safe: { nested: 1 }
      }
    };
    stripInternalToolingMetadata(metadata);
    assert.equal('toolCallIdStyle' in metadata, false);
    assert.equal('__rcc_raw_system' in metadata, false);
    assert.equal('__rcc_private' in metadata.extraFields, false);
    assert.deepEqual(metadata.extraFields.safe, { nested: 1 });
  }

  {
    assert.equal(sanitizeResponsesFunctionName('web-search'), 'web_search');
  }

  console.log('✅ coverage-responses-tool-utils passed');
}

main().catch((error) => {
  console.error('❌ coverage-responses-tool-utils failed:', error);
  process.exit(1);
});
