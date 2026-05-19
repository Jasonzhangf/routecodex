#!/usr/bin/env node
import assert from 'node:assert/strict';

function normalize(entryEndpoint, payload) {
  const endpoint = String(entryEndpoint || '').toLowerCase();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!endpoint.includes('/v1/responses')) return payload;
  if (Array.isArray(payload.input)) return payload;
  if (!Array.isArray(payload.messages)) return payload;

  const seenToolOutputs = new Set();
  const input = payload.messages.flatMap((m) => {
    const role = typeof m?.role === 'string' ? m.role.trim().toLowerCase() : 'user';
    if (role === 'tool' && typeof m?.tool_call_id === 'string' && m.tool_call_id.trim()) {
      const callId = m.tool_call_id.trim();
      if (seenToolOutputs.has(callId)) return [];
      seenToolOutputs.add(callId);
      return [{
        type: 'function_call_output',
        call_id: callId,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      }];
    }
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) {
      const items = [];
      for (const tc of m.tool_calls) {
        const id = typeof tc?.id === 'string' ? tc.id.trim() : '';
        const name = typeof tc?.function?.name === 'string' ? tc.function.name.trim() : '';
        if (!id || !name) continue;
        items.push({
          type: 'function_call',
          call_id: id,
          name,
          arguments:
            typeof tc?.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc?.function?.arguments ?? {})
        });
      }
      if (items.length > 0) return items;
    }
    if (Array.isArray(m?.content)) return [{ role, content: m.content }];
    return [{ role, content: [{ type: 'input_text', text: typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '') }] }];
  });
  const next = { ...payload, input };
  delete next.messages;
  return next;
}

function validate(entryEndpoint, payload) {
  const endpoint = String(entryEndpoint || '').toLowerCase();
  if (!endpoint.includes('/v1/responses')) return true;
  const hasInput = Array.isArray(payload?.input);
  const hasMessages = Array.isArray(payload?.messages);
  return !(hasMessages && !hasInput);
}

// case 1: text-only
{
  const raw = { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: '继续执行' }] };
  const out = normalize('/v1/responses', raw);
  assert.ok(validate('/v1/responses', out));
  assert.ok(Array.isArray(out.input));
}

// case 2: tool-result
{
  const raw = {
    model: 'gpt-5.3-codex',
    messages: [
      { role: 'assistant', content: 'run tool' },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
    ]
  };
  const out = normalize('/v1/responses', raw);
  assert.ok(validate('/v1/responses', out));
  assert.equal(out.input[1].type, 'function_call_output');
}

// case 2b: assistant tool_calls + tool output must keep pair
{
  const raw = {
    model: 'gpt-5.3-codex',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_pair_1',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: '{"cmd":"echo ok"}'
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_pair_1', content: '{"ok":true}' },
      { role: 'user', content: '继续执行' }
    ]
  };
  const out = normalize('/v1/responses', raw);
  assert.ok(validate('/v1/responses', out));
  const call = out.input.find((it) => it && typeof it === 'object' && it.type === 'function_call');
  const output = out.input.find((it) => it && typeof it === 'object' && it.type === 'function_call_output');
  assert.ok(call, 'expected function_call item from assistant.tool_calls');
  assert.ok(output, 'expected function_call_output item from tool message');
  assert.equal(call.call_id, 'call_pair_1');
  assert.equal(output.call_id, 'call_pair_1');
}

// case 3: multimodal content array
{
  const raw = {
    model: 'MiniMax-M2.7',
    messages: [
      { role: 'user', content: [
        { type: 'input_text', text: 'describe image' },
        { type: 'input_image', image_url: 'https://example.com/1.png' }
      ] }
    ]
  };
  const out = normalize('/v1/responses', raw);
  assert.ok(validate('/v1/responses', out));
  assert.ok(Array.isArray(out.input[0].content));
  assert.equal(out.input[0].content[1].type, 'input_image');
}

// case 4: duplicate tool outputs for same call_id should be deduped in followup normalize
{
  const raw = {
    model: 'gpt-5.3-codex',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_dup_1',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: '{"cmd":"echo x"}'
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_dup_1', content: '{"ok":1}' },
      { role: 'tool', tool_call_id: 'call_dup_1', content: '{"ok":1}' },
      { role: 'user', content: '继续执行' }
    ]
  };
  const out = normalize('/v1/responses', raw);
  const outputs = out.input.filter((it) => it && typeof it === 'object' && it.type === 'function_call_output');
  assert.equal(outputs.length, 1, 'duplicate function_call_output for same call_id must be deduped');
  assert.equal(outputs[0].call_id, 'call_dup_1');
}

console.log('✅ servertool followup shape replay (text/tool/multimodal) passed');
