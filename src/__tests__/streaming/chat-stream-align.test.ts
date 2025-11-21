import { Readable } from 'stream';
// Disable snapshots for tests to avoid FS writes and after-test logs
process.env.ROUTECODEX_SNAPSHOT_ENABLE = '0';
import { bridgeOpenAIChatUpstreamToEvents } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/openai-chat-upstream-bridge.js';
import { createChatSSEStreamFromChatJson } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/json-to-chat-sse.js';
import { assertEquivalent } from '../../../sharedmodule/llmswitch-core/src/v2/conversion/streaming/stream-equivalence.js';

function sseFromLines(lines: string[]): Readable {
  const src = new Readable({ read() {} });
  setImmediate(() => {
    for (const l of lines) src.push(l.endsWith('\n') ? l : l + '\n');
    src.push('');
  });
  return src;
}

describe('Chat SSE alignment (synthetic vs upstream passthrough)', () => {
  test('pure text completion matches', async () => {
    const upstreamLines = [
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: ', world' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1730000000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      'data: [DONE]'
    ];
    const upstream = bridgeOpenAIChatUpstreamToEvents(sseFromLines(upstreamLines));

    const finalJson = {
      id: 'chatcmpl_SYN',
      model: 'gpt-4o-mini',
      choices: [ { index: 0, message: { role: 'assistant', content: 'Hello, world' } } ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    };
    const synthSSE = createChatSSEStreamFromChatJson(finalJson, { requestId: 'req_test' });
    const synth = bridgeOpenAIChatUpstreamToEvents(synthSSE as unknown as Readable);

    const eq = await assertEquivalent(upstream, synth);
    expect(eq.equal).toBe(true);
  });

  test('tool call incremental arguments matches', async () => {
    const upstreamLines = [
      `data: ${JSON.stringify({ id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { arguments: '{"q":"hel' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { arguments: 'lo"}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 1730001000, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]'
    ];
    const upstream = bridgeOpenAIChatUpstreamToEvents(sseFromLines(upstreamLines));

    const finalJson = {
      id: 'chatcmpl_SYN2',
      model: 'gpt-4o-mini',
      choices: [ { index: 0, message: { role: 'assistant', content: null, tool_calls: [ { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"hello"}' } } ] } } ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
    };
    const synthSSE = createChatSSEStreamFromChatJson(finalJson, { requestId: 'req_test2' });
    const synth = bridgeOpenAIChatUpstreamToEvents(synthSSE as unknown as Readable);

    const eq = await assertEquivalent(upstream, synth);
    expect(eq.equal).toBe(true);
  });
});
