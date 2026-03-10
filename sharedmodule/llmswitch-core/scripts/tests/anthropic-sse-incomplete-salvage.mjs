import { Readable } from 'node:stream';
import { createAnthropicConverters } from '../../dist/sse/index.js';

function toSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function main() {
  const streamText = [
    toSse('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'glm-5.0' }
    }),
    toSse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }),
    toSse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello from incomplete anthropic sse' }
    })
    // Intentionally missing content_block_stop + message_stop
  ].join('');

  const stream = Readable.from([streamText]);
  const anthropic = createAnthropicConverters();
  const result = await anthropic.sseToJson.convertSseToJson(stream, { requestId: 'anthropic-incomplete-salvage' });
  const text = Array.isArray(result?.content)
    ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
    : '';

  if (!text.includes('incomplete anthropic sse')) {
    throw new Error(`salvage failed, text=${JSON.stringify(text)}`);
  }

  console.log('[anthropic-sse-incomplete-salvage] ok', JSON.stringify({ id: result?.id, stop_reason: result?.stop_reason, text }));
}

main().catch((error) => {
  console.error('[anthropic-sse-incomplete-salvage] failed', error);
  process.exit(1);
});
