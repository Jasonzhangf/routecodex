#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { extractToolCallsFromReasoningText } = await import('../../dist/conversion/shared/reasoning-tool-parser.js');

  {
    const result = extractToolCallsFromReasoningText(
      '<tool_call>\n<id>call_native_a</id>\nshell\n<arg_key>command</arg_key><arg_value>["pwd"]</arg_value>\n</tool_call>',
      { idPrefix: 'custom_reasoning' }
    );

    assert.equal(typeof result.cleanedText, 'string');
    assert.ok(Array.isArray(result.toolCalls));
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.id, 'call_native_a');
    assert.equal(result.toolCalls[0]?.function?.name, 'shell');
    assert.deepStrictEqual(
      JSON.parse(result.toolCalls[0]?.function?.arguments ?? '{}'),
      { command: ['pwd'] }
    );
  }

  {
    const result = extractToolCallsFromReasoningText('', { idPrefix: 'empty_reasoning' });
    assert.equal(result.cleanedText, '');
    assert.deepStrictEqual(result.toolCalls, []);
  }

  console.log('✅ coverage-reasoning-tool-parser passed');
}

main().catch((error) => {
  console.error('❌ coverage-reasoning-tool-parser failed:', error);
  process.exit(1);
});
