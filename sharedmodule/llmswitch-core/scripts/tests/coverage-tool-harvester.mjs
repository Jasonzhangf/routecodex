#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { harvestTools } = await import('../../dist/conversion/shared/tool-harvester.js');

  // delta: textual <function=execute>
  {
    const res = harvestTools(
      {
        type: 'delta',
        payload: {
          choices: [{ delta: { content: '<function=execute><parameter=command>ls -la</parameter></function=execute>' } }]
        }
      },
      { requestId: 'req_txt', idPrefix: 'call', chunkSize: 64, source: 'chat' }
    );
    assert.ok(res.deltaEvents.length >= 2, 'expected tool_calls + args chunks');
    const firstName = res.deltaEvents.find((e) => e.tool_calls?.[0]?.function?.name)?.tool_calls?.[0]?.function?.name;
    assert.equal(firstName, 'shell');
  }

  // delta: legacy function_call
  {
    const res = harvestTools(
      {
        type: 'delta',
        payload: {
          choices: [{ delta: { function_call: { name: 'shell', arguments: { command: ['pwd'] } } } }]
        }
      },
      { requestId: 'req_fc', idPrefix: 'call', chunkSize: 64, source: 'chat' }
    );
    assert.ok(res.deltaEvents.some((e) => e.tool_calls?.[0]?.function?.name === 'shell'));
  }

  // delta: direct tool_calls with adjacent dedupe
  {
    const payload = {
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'call_1', function: { name: 'shell', arguments: { command: ['echo', 'hi'] } } }
            ]
          }
        }
      ]
    };

    const a = harvestTools({ type: 'delta', payload }, { requestId: 'req_dedupe', chunkSize: 64 });
    const b = harvestTools({ type: 'delta', payload }, { requestId: 'req_dedupe', chunkSize: 64 });
    assert.ok(a.deltaEvents.length > 0, 'first chunk should emit tool_calls');
    assert.equal(b.deltaEvents.length, 0, 'duplicate chunk should be dropped');
  }

  // final: normalize structured tool_calls arguments + finish_reason
  {
    const src = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'shell', arguments: { command: ['ls'] } } }
            ]
          },
          finish_reason: 'stop'
        }
      ]
    };
    const res = harvestTools({ type: 'final', payload: src });
    assert.ok(res.normalized, 'expected normalized payload');
    assert.equal(src.choices[0].finish_reason, 'tool_calls');
    assert.equal(typeof src.choices[0].message.tool_calls[0].function.arguments, 'string');
  }

  // final: harvest textual <tool_call> markup from message.content
  {
    const src = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<tool_call><tool_name>shell</tool_name><arg_key>command</arg_key><arg_value>[\"ls\",\"-la\"]</arg_value></tool_call>'
          },
          finish_reason: 'stop'
        }
      ]
    };
    const res = harvestTools({ type: 'final', payload: src }, { requestId: 'req_text', chunkSize: 64 });
    assert.ok(res.normalized, 'expected normalized payload from textual harvest');
    assert.ok(Array.isArray(src.choices[0].message.tool_calls) && src.choices[0].message.tool_calls.length === 1);
    assert.equal(src.choices[0].finish_reason, 'tool_calls');
    assert.equal(src.choices[0].message.content, '');
  }

  console.log('✅ coverage-tool-harvester passed');
}

main().catch((e) => {
  console.error('❌ coverage-tool-harvester failed:', e);
  process.exit(1);
});

