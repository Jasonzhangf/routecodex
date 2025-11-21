import { Readable } from 'stream';
import { aggregateOpenAIChatSSEToJSON } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-sse-to-json.js';
import { createChatSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-chat-sse.js';
import { bridgeOpenAIChatUpstreamToEvents } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { assertEquivalent } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.js';

// Disable snapshots for tests
process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';

function sseFromLines(lines: string[]): Readable {
  const src = new Readable({ read() {} });
  setImmediate(() => {
    for (const l of lines) src.push(l.endsWith('\n') ? l : l + '\n');
    src.push('');
  });
  return src;
}

describe('Chat SSE aggregate loopback', () => {
  test('SSE → JSON aggregate → SSE roundtrip equivalent (text)', async () => {
    const upstreamLines = [
      `data: ${JSON.stringify({ id: 'chatcmpl_A', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_A', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: 'ABC' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_A', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: '123' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_A', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      'data: [DONE]'
    ];
    const upstreamReadable = sseFromLines(upstreamLines);
    const aggregated = await aggregateOpenAIChatSSEToJSON(upstreamReadable);
    expect(aggregated?.choices?.[0]?.message?.content).toBe('ABC123');
    const synthSSE = createChatSSEStreamFromChatJson(aggregated, { requestId: 'rt1' });
    const A = bridgeOpenAIChatUpstreamToEvents(sseFromLines(upstreamLines));
    const B = bridgeOpenAIChatUpstreamToEvents(synthSSE as unknown as Readable);
    const eq = await assertEquivalent(A, B);
    expect(eq.equal).toBe(true);
  });

  test('SSE → JSON aggregate → JSON matches (tool_calls)', async () => {
    const upstreamLines = [
      `data: ${JSON.stringify({ id: 'chatcmpl_B', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_B', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_X', type: 'function', function: { name: 'lookup' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_B', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_X', type: 'function', function: { arguments: '{"id":' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_B', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_X', type: 'function', function: { arguments: '42}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_B', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]'
    ];
    const upstreamReadable = sseFromLines(upstreamLines);
    const aggregated = await aggregateOpenAIChatSSEToJSON(upstreamReadable);
    const tc = aggregated?.choices?.[0]?.message?.tool_calls?.[0];
    expect(tc?.function?.name).toContain('lookup');
    expect(tc?.function?.arguments).toBe('{"id":42}');
    // Roundtrip back to SSE then event compare with original
    const synthSSE = createChatSSEStreamFromChatJson(aggregated, { requestId: 'rt2' });
    const A = bridgeOpenAIChatUpstreamToEvents(sseFromLines(upstreamLines));
    const B = bridgeOpenAIChatUpstreamToEvents(synthSSE as unknown as Readable);
    const eq = await assertEquivalent(A, B);
    expect(eq.equal).toBe(true);
  });
});

