#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    extractToolNamespaceXmlBlocksFromText,
    extractInvokeToolsFromText,
    extractBareExecCommandFromText,
    extractApplyPatchCallsFromText,
    extractExecuteBlocksFromText,
    extractXMLToolCallsFromText,
    normalizeAssistantTextToToolCalls
  } = await import('../../dist/conversion/shared/text-markup-normalizer.js');

  // <tool:NAME> blocks
  {
    const text = '<tool:exec_command><command>pwd</command></tool:exec_command>';
    const tools = extractToolNamespaceXmlBlocksFromText(text);
    assert.ok(Array.isArray(tools) && tools[0]?.name === 'exec_command');
  }

  // <invoke name="..."><parameter name="...">...</parameter></invoke>
  {
    const text = '<invoke name="shell"><parameter name="command">[\"ls\",\"-la\"]</parameter></invoke>';
    const tools = extractInvokeToolsFromText(text);
    assert.ok(Array.isArray(tools) && tools[0]?.name === 'shell');
  }

  // Broken markup fallback: bare exec_command extraction requires "broken tool markup" hint.
  {
    process.env.ROUTECODEX_WORKDIR = '/tmp';
    const text = '<tool_call>\nRan [\"rg\",\"-n\",\"TODO\",\".\"]\n</tool_call>';
    const tools = extractBareExecCommandFromText(text);
    assert.ok(Array.isArray(tools) && tools[0]?.name === 'exec_command');
  }

  // Structured apply_patch payloads inside fenced JSON.
  {
    const text = '```json\n{"changes":[{}]}\n```';
    const tools = extractApplyPatchCallsFromText(text);
    assert.ok(Array.isArray(tools) && tools[0]?.name === 'apply_patch');
  }

  // <function=execute> blocks
  {
    const text = '<function=execute><parameter=command>ls -la</parameter></function>';
    const tools = extractExecuteBlocksFromText(text);
    assert.ok(Array.isArray(tools) && tools[0]?.name === 'shell');
  }

  // <tool_call> XML-like blocks with arg_key/arg_value pairs
  {
    const text = '<tool_call>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>';
    const tools = extractXMLToolCallsFromText(text);
    assert.ok(Array.isArray(tools) && tools[0]?.name === 'shell');
  }

  // Normalize assistant message content into tool_calls shape
  {
    const msg = { role: 'assistant', content: '<tool_call>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>' };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls[0]?.function?.name === 'shell');
  }

  // Normalize assistant reasoning into tool_calls shape
  {
    const msg = { role: 'assistant', content: '', reasoning: '<tool_call>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>' };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls[0]?.function?.name === 'shell');
  }

  // Normalize assistant reasoning_content into tool_calls shape
  {
    const msg = { role: 'assistant', content: '', reasoning_content: '<tool_call>\nshell\n<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n</tool_call>' };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls[0]?.function?.name === 'shell');
  }


  // Normalize multiple tool_calls in reasoning_content and preserve id/arguments
  {
    const msg = {
      role: 'assistant',
      content: '',
      reasoning_content:
        '<tool_call>\n' +
        '<id>call_a</id>\n' +
        'shell\n' +
        '<arg_key>command</arg_key><arg_value>[\"pwd\"]</arg_value>\n' +
        '</tool_call>\n' +
        '<tool_call>\n' +
        '<id>call_b</id>\n' +
        'shell\n' +
        '<arg_key>command</arg_key><arg_value>[\"ls\"]</arg_value>\n' +
        '</tool_call>'
    };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls.length === 2);
    assert.equal(out.tool_calls[0]?.id, 'call_a');
    assert.ok(typeof out.tool_calls[0]?.function?.arguments === 'string');
    assert.equal(out.tool_calls[1]?.id, 'call_b');
    assert.ok(typeof out.tool_calls[1]?.function?.arguments === 'string');
  }


  // Normalize multiple tool_calls with explicit <id> and preserve arguments
  {
    const msg = {
      role: 'assistant',
      content: '',
      reasoning_content:
        '<tool_call>\n' +
        '<id>call_x</id>\n' +
        'shell\n' +
        '<arg_key>command</arg_key><arg_value>[\"echo x\"]</arg_value>\n' +
        '</tool_call>\n' +
        '<tool_call>\n' +
        '<id>call_y</id>\n' +
        'shell\n' +
        '<arg_key>command</arg_key><arg_value>[\"echo y\"]</arg_value>\n' +
        '</tool_call>'
    };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls.length === 2);
    assert.equal(out.tool_calls[0]?.id, 'call_x');
    assert.ok(out.tool_calls[0]?.function?.arguments?.includes('echo x'));
    assert.equal(out.tool_calls[1]?.id, 'call_y');
    assert.ok(out.tool_calls[1]?.function?.arguments?.includes('echo y'));
  }


  // multi_id_preserves_args
  {
    const msg = {
      role: 'assistant',
      content: '',
      reasoning_content:
        '<tool_call>\n' +
        '<id>call_a</id>\n' +
        'shell\n' +
        '<arg_key>payload</arg_key><arg_value>{"path":"C:\\\\tmp","meta":{"note":"line\\nnext","items":[1,{"k":"v"}]}}</arg_value>\n' +
        '</tool_call>\n' +
        '<tool_call>\n' +
        '<id>call_b</id>\n' +
        'shell\n' +
        '<arg_key>payload</arg_key><arg_value>{"path":"/tmp","meta":{"note":"quote: \\\"hi\\\"","items":[2,{"k":"w"}]}}</arg_value>\n' +
        '</tool_call>\n' +
        '<tool_call>\n' +
        '<id>call_c</id>\n' +
        'shell\n' +
        '<arg_key>payload</arg_key><arg_value>{"path":"/var/tmp","meta":{"note":"backslash: \\\\ end","items":[3,{"k":"z"}],"nested":{"a":1,"b":{"c":"d"}}}}</arg_value>\n' +
        '</tool_call>'
    };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls.length === 3);
    assert.equal(out.tool_calls[0]?.id, 'call_a');
    assert.equal(out.tool_calls[1]?.id, 'call_b');
    assert.equal(out.tool_calls[2]?.id, 'call_c');
    const argsA = JSON.parse(out.tool_calls[0]?.function?.arguments || '{}');
    const argsB = JSON.parse(out.tool_calls[1]?.function?.arguments || '{}');
    const argsC = JSON.parse(out.tool_calls[2]?.function?.arguments || '{}');
    assert.deepStrictEqual(argsA, { payload: { path: 'C:\\tmp', meta: { note: 'line\nnext', items: [1, { k: 'v' }] } } });
    assert.deepStrictEqual(argsB, { payload: { path: '/tmp', meta: { note: 'quote: "hi"', items: [2, { k: 'w' }] } } });
    assert.deepStrictEqual(argsC, {
      payload: {
        path: '/var/tmp',
        meta: {
          note: 'backslash: \\ end',
          items: [3, { k: 'z' }],
          nested: { a: 1, b: { c: 'd' } }
        }
      }
    });
  }

  // Normalize broken/partial JSON-like tool call text
  {
    const msg = { role: 'assistant', content: '```tool_call\n{\"name\":\"shell\",\"arguments\":{\"command\":\"pwd\"}\n```' };
    const out = normalizeAssistantTextToToolCalls(msg);
    assert.ok(Array.isArray(out.tool_calls) && out.tool_calls[0]?.function?.name === 'shell');
  }

  if (!process.env.C8_COVERAGE) {
    throw new Error('coverage-text-markup-normalizer requires c8 (C8_COVERAGE missing)');
  }

  console.log(`[coverage-text-markup-normalizer] C8_COVERAGE=${process.env.C8_COVERAGE}`);

  console.log('✅ coverage-text-markup-normalizer passed');
}

main().catch((e) => {
  console.error('❌ coverage-text-markup-normalizer failed:', e);
  process.exit(1);
});
