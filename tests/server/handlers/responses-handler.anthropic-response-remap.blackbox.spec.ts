import { describe, expect, it } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';
import { convertProviderResponse } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';

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

describe('responses HTTP anthropic provider response remap blackbox', () => {
  it('maps Anthropic Messages provider response to OpenAI Responses response without missing choices', async () => {
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const converted = await convertProviderResponse({
            providerProtocol: 'anthropic-messages',
            providerResponse: {
              id: 'msg_http_anthropic_response_1',
              type: 'message',
              role: 'assistant',
              model: 'mimo-v2.5',
              content: [{ type: 'text', text: 'anthropic response ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 7, output_tokens: 3 }
            },
            context: {
              requestId: input.requestId,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'anthropic-messages'
            } as any,
            entryEndpoint: '/v1/responses',
            wantsStream: false
          });
          return { status: 200, headers: {}, body: converted.body };
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5', input: 'hello' })
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ object: 'response', status: 'completed', model: 'mimo-v2.5' });
      expect(JSON.stringify(payload)).toContain('anthropic response ok');
      expect(JSON.stringify(payload)).not.toContain('missing choices');
    } finally {
      await closeServer(server);
    }
  });

  it('maps captured Anthropic SSE wrapper provider response to OpenAI Responses without content-array failure', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key2.mimo-v2.5/req_1780195058124_b12e1281/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.body?.mode).toBe('sse');
    expect(typeof sample?.body?.bodyText).toBe('string');

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const converted = await convertProviderResponse({
            providerProtocol: 'anthropic-messages',
            providerResponse: sample.body,
            context: {
              requestId: input.requestId,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'anthropic-messages'
            } as any,
            entryEndpoint: '/v1/responses',
            wantsStream: false
          });
          return { status: 200, headers: {}, body: converted.body };
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5', input: 'hello' })
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ object: 'response', status: 'requires_action', model: 'mimo-v2.5' });
      expect(JSON.stringify(payload)).toContain('exec_command');
      expect(JSON.stringify(payload)).not.toContain('Anthropic response must contain content array');
    } finally {
      await closeServer(server);
    }
  });

  it('maps latest captured mimo Anthropic SSE wrapper from 240109 without content-array failure', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/port-unknown/req_1780190256673_3e7bf0ce/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.meta?.providerKey).toBe('mimo.key2.mimo-v2.5');
    expect(sample?.body?.mode).toBe('sse');
    expect(typeof sample?.body?.bodyText).toBe('string');

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const converted = await convertProviderResponse({
            providerProtocol: 'anthropic-messages',
            providerResponse: sample.body,
            context: {
              requestId: input.requestId,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'anthropic-messages'
            } as any,
            entryEndpoint: '/v1/responses',
            wantsStream: false
          });
          return { status: 200, headers: {}, body: converted.body };
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5', input: 'hello' })
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ object: 'response', model: 'mimo-v2.5' });
      expect(JSON.stringify(payload)).not.toContain('Anthropic response must contain content array');
    } finally {
      await closeServer(server);
    }
  });

  it('maps captured 240110 mimo Anthropic live stream shape without content-array failure', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key2.mimo-v2.5/req_1780195058124_b12e1281/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.meta?.providerKey).toBe('mimo.key2.mimo-v2.5');
    expect(sample?.body?.mode).toBe('sse');
    expect(typeof sample?.body?.bodyText).toBe('string');

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const converted = await convertProviderResponse({
            providerProtocol: 'anthropic-messages',
            providerResponse: { __sse_responses: Readable.from([sample.body.bodyText]) },
            context: {
              requestId: input.requestId,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'anthropic-messages'
            } as any,
            entryEndpoint: '/v1/responses',
            wantsStream: false
          });
          return { status: 200, headers: {}, body: converted.body };
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5', input: 'hello' })
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ object: 'response', model: 'mimo-v2.5' });
      expect(JSON.stringify(payload)).not.toContain('Anthropic response must contain content array');
    } finally {
      await closeServer(server);
    }
  });

  it('fails fast on 240111 marker-only provider response instead of pretending it is Anthropic content', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5/req_1780050421483_3c30c5a5/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.meta?.providerKey).toBe('mimo.key1.mimo-v2.5');
    expect(sample?.body).toEqual(expect.objectContaining({ mode: 'sse' }));
    expect(sample?.body?.bodyText).toBeUndefined();
    expect(sample?.body?.__sse_responses).toBeUndefined();

    await expect(convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: sample.body,
      context: {
        requestId: 'red_240111_marker_only',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages'
      } as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    })).rejects.toThrow(/provider SSE marker did not include materializable stream or bodyText/i);
  });

  it('maps captured 240111 mimo Anthropic live stream shape even when client wants stream', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key2.mimo-v2.5/req_1780195058124_b12e1281/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.meta?.providerKey).toBe('mimo.key2.mimo-v2.5');
    expect(typeof sample?.body?.bodyText).toBe('string');

    const converted = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: { __sse_responses: Readable.from([sample.body.bodyText]) },
      context: {
        requestId: 'red_240111_stream_wants_stream',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages'
      } as any,
      entryEndpoint: '/v1/responses',
      wantsStream: true
    });
    expect(JSON.stringify(converted)).not.toContain('Anthropic response must contain content array');
    expect(converted.body ?? converted.__sse_responses).toBeTruthy();
  });

  it('maps Anthropic SSE raw marker text through the same materializer', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key2.mimo-v2.5/req_1780195058124_b12e1281/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    const converted = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: { mode: 'sse', raw: sample.body.bodyText },
      context: {
        requestId: 'raw_marker_text_materializer',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages'
      } as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });
    expect(JSON.stringify(converted)).not.toContain('Anthropic response must contain content array');
    expect(converted.body).toMatchObject({ object: 'response', model: 'mimo-v2.5' });
  });

  it('rejects captured MiniMax sse_passthrough marker over HTTP before missing choices', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/port-unknown/req_1780197597724_ubtm32b3e/provider-response.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.body).toMatchObject({ mode: 'sse_passthrough', clientStream: true });

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const converted = await convertProviderResponse({
            providerProtocol: 'openai-chat',
            providerResponse: sample.body,
            context: {
              requestId: input.requestId,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-chat'
            } as any,
            entryEndpoint: '/v1/responses',
            wantsStream: true
          });
          return { status: 200, headers: {}, body: converted.body };
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'MiniMax-M2.7', stream: true, input: 'hello' })
      });
      const text = await response.text();

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(text).toContain('Provider SSE marker did not include materializable stream or bodyText');
      expect(text).not.toContain('OpenAI chat response must contain choices array');
    } finally {
      await closeServer(server);
    }
  });

  it('maps captured MiniMax OpenAI chat SSE wrapper from 240109 without missing choices', async () => {
    const samplePath = '/Volumes/extension/.rcc/codex-samples/openai-responses/port-unknown/req_1780190256673_3e7bf0ce/provider-response_4.json';
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.meta?.providerKey).toBe('minimonth.key1.MiniMax-M2.7');
    expect(sample?.body?.mode).toBe('sse');
    expect(typeof sample?.body?.bodyText).toBe('string');

    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: any) => {
          const converted = await convertProviderResponse({
            providerProtocol: 'openai-chat',
            providerResponse: sample.body,
            context: {
              requestId: input.requestId,
              entryEndpoint: '/v1/responses',
              providerProtocol: 'openai-chat'
            } as any,
            entryEndpoint: '/v1/responses',
            wantsStream: false
          });
          return { status: 200, headers: {}, body: converted.body };
        },
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'MiniMax-M2.7', input: 'hello' })
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ object: 'response', model: 'MiniMax-M2.7' });
      expect(JSON.stringify(payload)).not.toContain('OpenAI chat response must contain choices array');
    } finally {
      await closeServer(server);
    }
  });
});
