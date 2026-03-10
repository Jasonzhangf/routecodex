#!/usr/bin/env node
/**
 * stop_message_flow followup trimmer regression:
 *
 * When trimming a long OpenAI-style message history for Gemini followups, we must
 * preserve the tool-call adjacency constraints:
 * - tool_calls (assistant) must have a preceding user (or tool response) turn
 * - tool responses (role=tool) must keep their preceding tool_call
 *
 * Otherwise Gemini rejects with:
 *   "Please ensure that function call turn comes immediately after a user turn
 *    or after a function response turn."
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const trimmerMod = await import(path.join(projectRoot, 'dist', 'servertool', 'handlers', 'followup-message-trimmer.js'));

const { trimOpenAiMessagesForFollowup } = trimmerMod;

function roleOf(msg) {
  return typeof msg?.role === 'string' ? msg.role : '';
}
function isSystem(msg) {
  const r = roleOf(msg).trim().toLowerCase();
  return r === 'system' || r === 'developer';
}
function isUser(msg) {
  return roleOf(msg).trim().toLowerCase() === 'user';
}
function isTool(msg) {
  const r = roleOf(msg).trim().toLowerCase();
  return r === 'tool' || r === 'function';
}
function isAssistantToolCall(msg) {
  const r = roleOf(msg).trim().toLowerCase();
  if (r !== 'assistant' && r !== 'model') return false;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
  if (msg.function_call && typeof msg.function_call === 'object') return true;
  return false;
}

async function main() {
  // 1 system + 19 non-system messages.
  // With maxNonSystemMessages=16, a naive tail-trim would drop:
  //   user(u0), assistant(tool_call#1), tool(resp#1)
  // causing the trimmed history to start with assistant(tool_call#2) => Gemini 400.
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u0' },
    { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'r1' },
    { role: 'assistant', tool_calls: [{ id: 'tc2', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc2', content: 'r2' },
    { role: 'assistant', tool_calls: [{ id: 'tc3', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc3', content: 'r3' },
    { role: 'assistant', tool_calls: [{ id: 'tc4', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc4', content: 'r4' },
    { role: 'assistant', tool_calls: [{ id: 'tc5', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc5', content: 'r5' },
    { role: 'assistant', tool_calls: [{ id: 'tc6', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc6', content: 'r6' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' },
    { role: 'user', content: 'u3' },
    { role: 'user', content: 'u4' },
    { role: 'user', content: 'u5' }
  ];

  const trimmed = trimOpenAiMessagesForFollowup(messages, { maxNonSystemMessages: 16 });
  assert.ok(Array.isArray(trimmed) && trimmed.length > 0, 'trimmed must be a non-empty array');

  // First non-system message must be user (do not drop tool_call chain; add an anchor).
  const firstNonSystem = trimmed.find((m) => !isSystem(m));
  assert.ok(firstNonSystem, 'trimmed must contain a non-system message');
  assert.ok(isUser(firstNonSystem), `first non-system message must be user, got role=${roleOf(firstNonSystem)}`);

  // If any tool response is present, there must be a preceding assistant tool_call in the trimmed history.
  for (let i = 0; i < trimmed.length; i += 1) {
    const m = trimmed[i];
    if (!isTool(m)) continue;
    const prev = trimmed[i - 1];
    assert.ok(prev, 'tool message must not be first');
    assert.ok(isAssistantToolCall(prev), 'tool message must be preceded by assistant tool_call message');
  }

  // The initial tool-call chain should be preserved (u0, tc1, r1) even though it was outside the naive tail window.
  const roles = trimmed.map((m) => roleOf(m).trim().toLowerCase());
  const joined = roles.join(',');
  assert.ok(joined.includes('user,assistant,tool'), 'expected initial tool-call chain to be present');

  console.log('✅ stop_message_flow followup trimmer regression passed');
}

main().catch((err) => {
  console.error('❌ stop-message-followup-trimmer test failed:', err);
  process.exit(1);
});

