import { Readable } from 'node:stream';
import { createAnthropicConverters } from '../../dist/sse/index.js';

function toSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function main() {
  const streamText = [
    toSse('error', {
      error: {
        code: '1211',
        message: 'Unknown Model, please check the model code.'
      },
      request_id: 'req_err_1'
    }),
    'data: [DONE]\n\n'
  ].join('');

  const stream = Readable.from([streamText]);
  const anthropic = createAnthropicConverters();

  try {
    await anthropic.sseToJson.convertSseToJson(stream, { requestId: 'anthropic-sse-error-event' });
    throw new Error('expected converter to fail on anthropic error event');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Anthropic SSE stream incomplete')) {
      throw new Error(`expected upstream error message, got incomplete: ${message}`);
    }
    if (!message.includes('Unknown Model')) {
      throw new Error(`expected upstream model error message, got: ${message}`);
    }
    console.log('[anthropic-sse-error-event] ok', message);
  }
}

main().catch((error) => {
  console.error('[anthropic-sse-error-event] failed', error);
  process.exit(1);
});
