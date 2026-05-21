import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('responses-handler gpt-5.3-codex stream regression', () => {
  it('keeps client-requested gpt-5.3-codex model visible in streamed response.completed contract', async () => {
    const executePipeline = jest.fn(async (input: any) => {
      const requestedModel = input?.body?.model;
      return {
        status: 200,
        headers: {
          'x-upstream-mode': 'sse',
          'x-provider-stream-requested': '1'
        },
        body: {
          __sse_responses: Readable.from([
            'event: response.created\n',
            `data: ${JSON.stringify({
              type: 'response.created',
              response: {
                id: 'resp_gpt53_stream_1',
                object: 'response',
                status: 'in_progress',
                model: requestedModel,
                output: []
              }
            })}\n\n`,
            'event: response.in_progress\n',
            `data: ${JSON.stringify({
              type: 'response.in_progress',
              response: {
                id: 'resp_gpt53_stream_1',
                object: 'response',
                status: 'in_progress',
                model: requestedModel,
                output: []
              }
            })}\n\n`,
            'event: response.output_text.delta\n',
            `data: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'OK'
            })}\n\n`,
            'event: response.completed\n',
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_gpt53_stream_1',
                object: 'response',
                status: 'completed',
                model: requestedModel,
                output: [
                  {
                    id: 'msg_gpt53_stream_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'OK' }]
                  }
                ]
              }
            })}\n\n`
          ])
        }
      };
    });

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline,
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          stream: true,
          input: 'Reply with OK only.'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.completed');
      expect(text).toContain('"model":"gpt-5.3-codex"');
      expect(text).not.toContain('"model":"gpt-5.4"');
      expect(executePipeline).toHaveBeenCalledTimes(1);
      expect(executePipeline.mock.calls[0]?.[0]?.body?.model).toBe('gpt-5.3-codex');
    });
  });

  it('restores client model and reasoning.effort in streamed response.completed even when upstream/provider payload is overridden', async () => {
    const executePipeline = jest.fn(async (input: any) => {
      expect(input?.body?.model).toBe('gpt-5.3-codex');
      expect(input?.body?.reasoning?.effort).toBe('high');
      return {
        status: 200,
        headers: {
          'x-upstream-mode': 'sse',
          'x-provider-stream-requested': '1'
        },
        body: {
          __sse_responses: Readable.from([
            'event: response.created\n',
            `data: ${JSON.stringify({
              type: 'response.created',
              response: {
                id: 'resp_restore_contract_1',
                object: 'response',
                status: 'in_progress',
                model: 'gpt-5.4',
                reasoning: { effort: 'none' },
                output: []
              }
            })}\n\n`,
            'event: response.completed\n',
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_restore_contract_1',
                object: 'response',
                status: 'completed',
                model: 'gpt-5.4',
                reasoning: { effort: 'none' },
                output: [
                  {
                    id: 'msg_restore_contract_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'OK' }]
                  }
                ]
              }
            })}\n\n`
          ])
        },
        metadata: {
          clientModelId: 'gpt-5.3-codex',
          originalModelId: 'gpt-5.3-codex',
          reasoning: { effort: 'high' },
          target: {
            clientModelId: 'gpt-5.3-codex'
          }
        }
      };
    });

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline,
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          reasoning: { effort: 'high' },
          stream: true,
          input: 'Reply with OK only.'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.completed');
      expect(text).toContain('"model":"gpt-5.3-codex"');
      expect(text).toContain('"reasoning":{"effort":"high"}');
      expect(text).not.toContain('"model":"gpt-5.4"');
      expect(text).not.toContain('"reasoning":{"effort":"none"}');
    });
  });


  it('restores client model from __raw_request_body fallback when metadata lacks clientModelId but keeps reasoning.effort', async () => {
    const executePipeline = jest.fn(async (input: any) => {
      expect(input?.body?.model).toBe('gpt-5.3-codex');
      expect(input?.body?.reasoning?.effort).toBe('high');
      return {
        status: 200,
        headers: {
          'x-upstream-mode': 'sse',
          'x-provider-stream-requested': '1'
        },
        body: {
          __sse_responses: Readable.from([
            'event: response.created\n',
            `data: ${JSON.stringify({
              type: 'response.created',
              response: {
                id: 'resp_restore_contract_rawreq_1',
                object: 'response',
                status: 'in_progress',
                model: 'gpt-5.4',
                reasoning: { effort: 'none' },
                output: []
              }
            })}\n\n`,
            'event: response.completed\n',
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_restore_contract_rawreq_1',
                object: 'response',
                status: 'completed',
                model: 'gpt-5.4',
                reasoning: { effort: 'none' },
                output: [
                  {
                    id: 'msg_restore_contract_rawreq_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'OK' }]
                  }
                ]
              }
            })}\n\n`
          ])
        },
        metadata: {
          __raw_request_body: {
            model: 'gpt-5.3-codex',
            reasoning: { effort: 'high' }
          }
        }
      };
    });

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline,
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          reasoning: { effort: 'high' },
          stream: true,
          input: 'Reply with OK only.'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.completed');
      expect(text).toContain('"model":"gpt-5.3-codex"');
      expect(text).toContain('"reasoning":{"effort":"high"}');
      expect(text).not.toContain('"model":"gpt-5.4"');
      expect(text).not.toContain('"reasoning":{"effort":"none"}');
    });
  });
});
