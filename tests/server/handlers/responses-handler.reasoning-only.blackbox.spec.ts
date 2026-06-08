import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildResponsesPayloadFromChatWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('responses HTTP reasoning-only blackbox', () => {
  it('does not emit duplicate message output item for reasoning-only provider response', async () => {
    const responsesBody = buildResponsesPayloadFromChatWithNative(
      {
        id: 'chatcmpl_reasoning_only',
        model: 'gpt-5.5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning: {
                summary: [{ type: 'summary_text', text: 'Let me inspect tool_call_entry.rs.' }],
                content: [{ type: 'reasoning_text', text: 'Let me inspect tool_call_entry.rs.' }]
              }
            }
          }
        ]
      },
      { requestId: 'req_http_reasoning_only_no_message' }
    ) as Record<string, unknown>;
    const output = responsesBody.output as Array<Record<string, unknown>>;
    expect(output.map((item) => item.type)).toEqual(['reasoning']);

    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: false, stream: false },
      body: responsesBody
    }));

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, { executePipeline, errorHandling: null });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', stream: false, input: 'continue' })
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('application/json');
      expect(body.output.map((item: any) => item.type)).toEqual(['reasoning']);
      expect(JSON.stringify(body)).not.toContain('"type":"message"');
      expect(JSON.stringify(body)).not.toContain('Let me inspect tool_call_entry.rs."}],"role":"assistant"');
    } finally {
      await closeServer(server);
    }
  });
});
