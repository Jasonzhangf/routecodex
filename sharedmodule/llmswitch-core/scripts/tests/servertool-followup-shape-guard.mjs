#!/usr/bin/env node
import assert from 'node:assert/strict';

function validateServertoolFollowupPayloadShape(args) {
  const endpoint = String(args?.entryEndpoint || '').toLowerCase();
  const payload = args?.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
    ? args.payload
    : undefined;

  if (!endpoint.includes('/v1/responses')) return { ok: true };

  const hasInput = Array.isArray(payload?.input);
  const hasMessages = Array.isArray(payload?.messages);

  if (!hasInput && hasMessages) {
    return {
      ok: false,
      violation: {
        code: 'RESPONSES_FOLLOWUP_MESSAGES_ONLY',
        reason: 'responses followup payload must use input shape; messages-only payload is illegal'
      }
    };
  }

  return { ok: true };
}

function normalizeServertoolFollowupPayloadShape(args) {
  const endpoint = String(args?.entryEndpoint || '').toLowerCase();
  const payload = args?.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
    ? { ...args.payload }
    : null;
  if (!payload) return null;
  if (!endpoint.includes('/v1/responses')) return payload;
  if (Array.isArray(payload.input)) return payload;
  if (!Array.isArray(payload.messages)) return payload;

  const input = payload.messages.map((m) => {
    const role = typeof m?.role === 'string' ? m.role.trim().toLowerCase() : 'user';
    if (role === 'tool') {
      if (typeof m?.tool_call_id === 'string' && m.tool_call_id.trim()) {
        return {
          type: 'function_call_output',
          call_id: m.tool_call_id.trim(),
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
        };
      }
      return {
        role: 'user',
        content: [{ type: 'input_text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }]
      };
    }
    if (Array.isArray(m?.content)) {
      return { role, content: m.content };
    }
    return {
      role,
      content: [{ type: 'input_text', text: typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '') }]
    };
  });

  const next = { ...payload, input };
  delete next.messages;
  return next;
}

function run() {
  const illegal = {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: '继续执行' }]
  };

  const bad = validateServertoolFollowupPayloadShape({ entryEndpoint: '/v1/responses', payload: illegal });
  assert.equal(bad.ok, false, 'messages-only responses followup must be rejected');

  const normalized = normalizeServertoolFollowupPayloadShape({ entryEndpoint: '/v1/responses', payload: illegal });
  assert.ok(normalized && Array.isArray(normalized.input), 'normalizer must create input[]');
  assert.equal(Array.isArray(normalized.messages), false, 'normalizer must remove messages[]');

  const post = validateServertoolFollowupPayloadShape({ entryEndpoint: '/v1/responses', payload: normalized });
  assert.equal(post.ok, true, 'normalized payload should pass');

  const goodChat = validateServertoolFollowupPayloadShape({
    entryEndpoint: '/v1/chat/completions',
    payload: { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: '继续执行' }] }
  });
  assert.equal(goodChat.ok, true, 'chat completions payload should not be blocked');

  console.log('✅ servertool followup shape guard + normalize regression passed');
}

run();
