import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleChatCompletions } from '../../../src/server/handlers/chat-handler.js';
import { handleImageGenerations } from '../../../src/server/handlers/images-handler.js';
import { handleMessages } from '../../../src/server/handlers/messages-handler.js';
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

async function fetchJson(baseUrl: string, routePath: string, body: unknown): Promise<{ status: number; payload: any }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : null };
}

describe('handler metadata boundary', () => {
  it('keeps request body metadata out of chat pipeline body', async () => {
    const executePipeline = jest.fn(async () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) => void handleChatCompletions(req as any, res as any, { executePipeline, errorHandling: null }));
    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/chat/completions', {
        model: 'gpt-test',
        metadata: { session_id: 'chat-sess' },
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.metadata.session_id).toBe('chat-sess');
    } finally {
      await closeServer(server);
    }
  });

  it('keeps request body metadata out of responses pipeline body', async () => {
    const executePipeline = jest.fn(async () => ({ status: 200, body: { object: 'response', output: [] } }));
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) => void handleResponses(req as any, res as any, { executePipeline, errorHandling: null }));
    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-test',
        metadata: { session_id: 'responses-sess' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.metadata.session_id).toBe('responses-sess');
    } finally {
      await closeServer(server);
    }
  });

  it('keeps request body metadata out of persisted responses request context', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_metadata_context',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      }
    }));
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) => void handleResponses(req as any, res as any, { executePipeline, errorHandling: null }));
    const { server, baseUrl } = await listenApp(app);
    try {
      await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-test',
        store: true,
        metadata: { session_id: 'persisted-context-must-not-leak' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      });
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.metadata.responsesRequestContext?.payload?.metadata).toBeUndefined();
      expect(JSON.stringify(input.metadata.responsesRequestContext?.payload)).not.toContain('persisted-context-must-not-leak');
    } finally {
      await closeServer(server);
    }
  });

  it('keeps request body metadata out of messages pipeline body', async () => {
    const executePipeline = jest.fn(async () => ({ status: 200, body: { type: 'message', content: [{ type: 'text', text: 'ok' }] } }));
    const app = express();
    app.use(express.json());
    app.post('/v1/messages', (req, res) => void handleMessages(req as any, res as any, { executePipeline, errorHandling: null }));
    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/messages', {
        model: 'claude-test',
        metadata: { session_id: 'messages-sess' },
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.metadata.session_id).toBe('messages-sess');
    } finally {
      await closeServer(server);
    }
  });

  it('keeps image metadata in carrier and out of chat pipeline body', async () => {
    const executePipeline = jest.fn(async () => ({ status: 200, body: { choices: [{ message: { content: 'https://example.test/generated.png' } }] } }));
    const app = express();
    app.use(express.json());
    app.post('/v1/images/generations', (req, res) => void handleImageGenerations(req as any, res as any, { executePipeline, errorHandling: null }));
    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/images/generations', {
        prompt: 'draw boundary',
        metadata: { session_id: 'image-sess' }
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.body.qwenImageGeneration).toMatchObject({ enabled: true, mode: 'generate' });
      expect(input.metadata.session_id).toBe('image-sess');
      expect(input.metadata.qwenImageGeneration).toMatchObject({ enabled: true, mode: 'generate' });
    } finally {
      await closeServer(server);
    }
  });
});
