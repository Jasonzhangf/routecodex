import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import {
  captureResponsesRequestContextForRequest,
  clearAllResponsesConversationState,
  recordResponsesResponseForRequest,
} from '../../../src/modules/llmswitch/bridge.js';

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

describe('responses handler attachment history placeholder blackbox', () => {
  afterEach(async () => {
    await clearAllResponsesConversationState();
  });

  it('keeps current submit_tool_outputs attachment and replaces stored history attachment', async () => {
    await clearAllResponsesConversationState();

    const requestId = 'req_http_attachment_history_1';
    await captureResponsesRequestContextForRequest({
      requestId,
      payload: {
        model: 'gpt-base',
        store: true,
        stream: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,HISTORYHTTP' },
              { type: 'input_text', text: 'look' },
            ],
          },
          {
            type: 'function_call',
            id: 'fc_http_1',
            call_id: 'call_http_1',
            name: 'view_image',
            arguments: '{"path":"/tmp/current.png"}',
          },
        ],
        tools: [{ type: 'function', name: 'view_image', parameters: { type: 'object', properties: {} } }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,HISTORYHTTP' },
              { type: 'input_text', text: 'look' },
            ],
          },
          {
            type: 'function_call',
            id: 'fc_http_1',
            call_id: 'call_http_1',
            name: 'view_image',
            arguments: '{"path":"/tmp/current.png"}',
          },
        ],
        toolsRaw: [{ type: 'function', name: 'view_image', parameters: { type: 'object', properties: {} } }],
      },
    });
    await recordResponsesResponseForRequest({
      requestId,
      response: {
        id: 'resp_http_attachment_1',
        output: [
          {
            type: 'function_call',
            id: 'fc_http_1',
            call_id: 'call_http_1',
            name: 'view_image',
            arguments: '{"path":"/tmp/current.png"}',
          },
        ],
      },
    });

    let capturedPipelineBody: unknown;
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => {
      void handleResponses(
        req as any,
        res as any,
        {
          executePipeline: async (input) => {
            capturedPipelineBody = input.body;
            return {
              status: 200,
              headers: {},
              body: {
                id: 'resp_http_attachment_2',
                object: 'response',
                status: 'completed',
                model: 'gpt-base',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
              },
            };
          },
          errorHandling: null,
        },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: (req as any).params.id,
        },
      );
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses/resp_http_attachment_1/submit_tool_outputs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool_outputs: [
            {
              tool_call_id: 'call_http_1',
              output: '[{"type":"input_image","image_url":"data:image/png;base64,CURRENTHTTP"}]',
            },
          ],
        }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('resp_http_attachment_2');

      const serialized = JSON.stringify(capturedPipelineBody);
      expect(serialized).toContain('[Image omitted]');
      expect(serialized).not.toContain('data:image/png;base64,HISTORYHTTP');
      expect(serialized).toContain('data:image/png;base64,CURRENTHTTP');
    } finally {
      await closeServer(server);
    }
  });
});
