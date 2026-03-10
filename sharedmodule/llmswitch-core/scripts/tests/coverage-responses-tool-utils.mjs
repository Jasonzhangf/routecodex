#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    normalizeResponsesToolCallIds,
    resolveToolCallIdStyle,
    stripInternalToolingMetadata,
    sanitizeResponsesFunctionName
  } = await import('../../dist/conversion/shared/responses-tool-utils.js');

  {
    const payload = {
      output: [
        { type: 'function_call', id: 'toolu_1', call_id: 'toolu_1' },
        { type: 'function_call_output', id: 'result_1', tool_call_id: 'toolu_1' },
        {
          type: 'message',
          tool_calls: [
            { id: 'toolu_nested', tool_call_id: 'toolu_nested' }
          ]
        }
      ],
      required_action: {
        submit_tool_outputs: {
          tool_calls: [{ id: 'toolu_1', tool_call_id: 'toolu_1' }]
        }
      }
    };

    normalizeResponsesToolCallIds(payload);

    assert.match(payload.output[0].call_id, /^fc_/);
    assert.match(payload.output[0].id, /^fc_/);
    assert.match(payload.output[1].call_id, /^fc_/);
    assert.match(payload.output[1].id, /^fc_/);
    assert.match(payload.output[2].tool_calls[0].id, /^fc_/);
    assert.match(payload.required_action.submit_tool_outputs.tool_calls[0].tool_call_id, /^fc_/);
  }

  {
    assert.equal(resolveToolCallIdStyle(undefined), 'fc');
    assert.equal(resolveToolCallIdStyle({ toolCallIdStyle: 'preserve' }), 'preserve');
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
