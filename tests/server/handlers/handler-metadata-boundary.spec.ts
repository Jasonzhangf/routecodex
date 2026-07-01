import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';

import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
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

function createHandlerIo(body: Record<string, unknown>): { req: any; res: any; writes: { status?: number; json?: unknown } } {
  const req = new EventEmitter() as any;
  req.headers = { 'content-type': 'application/json' };
  req.method = 'POST';
  req.query = {};
  req.body = body;
  const writes: { status?: number; json?: unknown } = {};
  const res = new EventEmitter() as any;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.status = jest.fn((status: number) => {
    writes.status = status;
    return res;
  });
  res.json = jest.fn((payload: unknown) => {
    writes.json = payload;
    res.headersSent = true;
    res.writableEnded = true;
    res.emit('finish');
    return res;
  });
  res.setHeader = jest.fn();
  res.write = jest.fn();
  res.end = jest.fn(() => {
    res.writableEnded = true;
    res.emit('finish');
    return res;
  });
  return { req, res, writes };
}

describe('handler metadata boundary', () => {
  it('routes chat client-response metadata projection failures through handler error path', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: { id: 'chatcmpl_metadata_leak', choices: [], metadata: { internal: true } }
    }));
    const { req, res, writes } = createHandlerIo({ model: 'gpt-test', messages: [] });

    await handleChatCompletions(req, res, { executePipeline, errorHandling: null });

    expect(writes.status).toBeGreaterThanOrEqual(500);
    expect((writes.json as any)?.error?.code).toBe('HTTP_HANDLER_ERROR');
    expect(JSON.stringify(writes.json)).not.toContain('metadata');
  });

  it('routes messages client-response metadata projection failures through handler error path', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: { type: 'message', content: [], metadata: { internal: true } }
    }));
    const { req, res, writes } = createHandlerIo({ model: 'claude-test', messages: [] });

    await handleMessages(req, res, { executePipeline, errorHandling: null });

    expect(writes.status).toBeGreaterThanOrEqual(500);
    expect((writes.json as any)?.error?.code).toBe('HTTP_HANDLER_ERROR');
    expect(JSON.stringify(writes.json)).not.toContain('metadata');
  });

  it('keeps request body metadata out of chat pipeline body', async () => {
    const executePipeline = jest.fn(async () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', (req, res) => void handleChatCompletions(req as any, res as any, { executePipeline, errorHandling: null }));
    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/chat/completions', {
        model: 'gpt-test',
        metadata: { userAgent: 'chat-sess' },
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.metadata.userAgent).toBe('chat-sess');
    } finally {
      await closeServer(server);
    }
  });

  it('keeps request body metadata out of responses pipeline body', async () => {
    const executePipeline = jest.fn(async () => ({ status: 200, body: { object: 'response', output: [] } }));
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', (req, res) => void handleResponses(req as any, res as any, {
      executePipeline,
      errorHandling: null,
      portContext: {
        matchedPort: 5555,
        routingPolicyGroup: 'gateway_priority_5555',
        stopMessageEnabled: true,
        stopMessageExcludeDirect: true
      }
    }));
    const { server, baseUrl } = await listenApp(app);
    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-test',
        stream: false,
        metadata: { userAgent: 'responses-sess' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toEqual({ userAgent: 'responses-sess' });
      expect(input.hubBody.metadata).toBeUndefined();
      const runtimeControl = MetadataCenter.read(input.metadata)?.readRuntimeControl();
      expect(runtimeControl?.stopMessageEnabled).toBe(true);
      expect(input.metadata.stopMessageEnabled).toBeUndefined();
      expect(input.metadata.routecodexPortStopMessageEnabled).toBeUndefined();
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
        stream: false,
        metadata: { userAgent: 'persisted-context-must-not-leak' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      });
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toEqual({ userAgent: 'persisted-context-must-not-leak' });
      expect(input.hubBody.metadata).toBeUndefined();
      expect(input.metadata.responsesRequestContext).toBeUndefined();
      const center = MetadataCenter.read(input.metadata);
      const requestContextPayload = center?.readContinuationContext().responsesRequestContext?.payload;
      expect(requestContextPayload?.metadata).toBeUndefined();
      expect(JSON.stringify(requestContextPayload ?? null)).not.toContain('persisted-context-must-not-leak');
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
        metadata: { userAgent: 'messages-sess' },
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.metadata.userAgent).toBe('messages-sess');
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
        model: 'gpt-image-test',
        prompt: 'draw boundary',
        metadata: { userAgent: 'image-sess' }
      });
      expect(result.status).toBe(200);
      const input = executePipeline.mock.calls[0]?.[0] as any;
      expect(input.body.metadata).toBeUndefined();
      expect(input.body.imageGeneration).toMatchObject({ enabled: true, mode: 'generate' });
      expect(input.metadata.userAgent).toBe('image-sess');
      expect(input.metadata.imageGeneration).toMatchObject({ enabled: true, mode: 'generate' });
    } finally {
      await closeServer(server);
    }
  });
});
