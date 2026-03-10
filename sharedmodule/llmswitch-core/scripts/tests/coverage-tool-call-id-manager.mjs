#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    ToolCallIdManager,
    normalizeIdValue,
    extractToolCallId,
    createToolCallIdTransformer,
    enforceToolCallIdStyle
  } = await import('../../dist/conversion/shared/tool-call-id-manager.js');

  {
    const manager = new ToolCallIdManager({ style: 'fc' });
    const first = manager.generateId();
    const second = manager.generateId();
    assert.match(first, /^fc_/);
    assert.match(second, /^fc_/);
    assert.notEqual(first, second);
    assert.match(manager.normalizeId('legacy_call'), /^fc_/);
  }

  {
    const manager = new ToolCallIdManager({ style: 'preserve' });
    const aliases = new Map();
    const a = manager.normalizeIdWithAlias(' call_a ', aliases);
    const b = manager.normalizeIdWithAlias('call_a', aliases);
    const generated = manager.normalizeIdWithAlias('', aliases);
    assert.equal(a, 'call_a');
    assert.equal(b, 'call_a');
    assert.ok(typeof generated === 'string' && generated.length > 0);
  }

  {
    assert.equal(normalizeIdValue('  abc  '), 'abc');
    assert.equal(extractToolCallId({ tool_call_id: 'tool_1' }), 'tool_1');
  }

  {
    const transformer = createToolCallIdTransformer('fc');
    assert.ok(transformer);
    const a = transformer('call_a');
    const b = transformer('');
    assert.match(a, /^fc_/);
    assert.match(b, /^fc_/);
  }

  {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'done' }
    ];
    const seen = [];
    enforceToolCallIdStyle(messages, (id) => {
      seen.push(id);
      return `wrapped_${id}`;
    });
    assert.equal(messages[0].tool_calls[0].id.startsWith('wrapped_fc_'), true);
    assert.equal(messages[1].tool_call_id.startsWith('wrapped_fc_'), true);
    assert.equal(seen.length, 2);
  }

  console.log('✅ coverage-tool-call-id-manager passed');
}

main().catch((error) => {
  console.error('❌ coverage-tool-call-id-manager failed:', error);
  process.exit(1);
});
