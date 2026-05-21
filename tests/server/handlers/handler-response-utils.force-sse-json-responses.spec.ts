import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { sendPipelineResponse } from '../../../src/server/handlers/handler-response-utils.js';
import { normalizeResponsesJsonBody } from '../../../src/server/handlers/handler-response-utils.js';

describe('handler-response-utils forceSSE responses json bridge', () => {
  it('encodes JSON responses payload into client-visible SSE instead of sse_bridge_error', async () => {
    const app = express();
    app.get('/responses-sse-from-json', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'resp_json_bridge_1',
            object: 'response',
            status: 'completed',
            model: 'gpt-5.4-medium',
            output: [
              {
                id: 'msg_json_bridge_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'OK' }]
              }
            ]
          }
        } as any,
        'req_force_sse_json_bridge',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses-sse-from-json`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: response.created');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('"type":"response.completed"');
      expect(text).not.toContain('sse_bridge_error');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('encodes chat.completion JSON into /v1/responses SSE instead of sse_bridge_error', async () => {
    const app = express();
    app.get('/responses-sse-from-chat-json', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'chatcmpl_json_bridge_1',
            object: 'chat.completion',
            model: 'gpt-5.4-medium',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'OK'
                },
                finish_reason: 'stop'
              }
            ]
          }
        } as any,
        'req_force_sse_chat_json_bridge',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses-sse-from-chat-json`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: response.created');
      expect(text).toContain('event: response.completed');
      expect(text).not.toContain('sse_bridge_error');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('normalizes chat.completion JSON into response object for /v1/responses JSON dispatch', async () => {
    const normalized = normalizeResponsesJsonBody(
      {
        id: 'chatcmpl_json_dispatch_1',
        object: 'chat.completion',
        model: 'gpt-5.4-medium',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'OK'
            },
            finish_reason: 'stop'
          }
        ]
      },
      '/v1/responses',
      'req_json_dispatch_chat_bridge',
      (() => ({
        buildResponsesPayloadFromChat: (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          object: 'response',
          status: 'completed',
          output: []
        })
      })) as any
    ) as Record<string, unknown>;

    expect(normalized.object).toBe('response');
    expect(normalized.object).not.toBe('chat.completion');
    expect(normalized.status).toBe('completed');
    expect(JSON.stringify(normalized)).not.toContain('chat.completion');
  });
});
