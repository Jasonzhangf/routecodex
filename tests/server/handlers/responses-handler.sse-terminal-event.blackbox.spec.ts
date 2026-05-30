import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

describe('responses-handler SSE terminal contract', () => {
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

  it('HTTP blackbox: streams response.done after response.completed without upstream_stream_incomplete', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: true, stream: true },
      body: {
        __sse_responses: Readable.from([
          'event: response.output_item.added\n',
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '' }
          })}\n\n`,
          'event: response.function_call_arguments.done\n',
          `data: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, call_id: 'call_1', arguments: '{}' })}\n\n`,
          'event: response.output_item.done\n',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '{}' }
          })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              object: 'response',
              status: 'requires_action',
              output: [{ id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '{}' }],
              required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [{ id: 'call_1', type: 'function_call', function: { name: 'shell', arguments: '{}' } }] } }
            }
          })}\n\n`,
          'event: response.done\n',
          `data: ${JSON.stringify({
            type: 'response.done',
            response: {
              id: 'resp_1',
              object: 'response',
              status: 'requires_action',
              output: [{ id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '{}' }],
              required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [{ id: 'call_1', type: 'function_call', function: { name: 'shell', arguments: '{}' } }] } }
            }
          })}\n\n`
        ])
      }
    }));

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, { executePipeline, errorHandling: null });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'gpt-5.5', stream: true, input: 'call tool' })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });

  it('HTTP blackbox: upstream closes without response.done — repair emits response.done', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: true, stream: true },
      body: {
        __sse_responses: Readable.from([
          'event: response.output_item.added\n',
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '' }
          })}\n\n`,
          'event: response.function_call_arguments.done\n',
          `data: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, call_id: 'call_1', arguments: '{}' })}\n\n`,
          'event: response.output_item.done\n',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '{}' }
          })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              object: 'response',
              status: 'requires_action',
              output: [{ id: 'fc_1', type: 'function_call', status: 'completed', name: 'shell', call_id: 'call_1', arguments: '{}' }],
              required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [{ id: 'call_1', type: 'function_call', function: { name: 'shell', arguments: '{}' } }] } }
            }
          })}\n\n`
          // NOTE: No response.done — simulates upstream timeout/close before terminal event
        ])
      }
    }));

    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, { executePipeline, errorHandling: null });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'gpt-5.5', stream: true, input: 'call tool' })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      // The repair path must emit response.done so client SDKs see a normal terminal event
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('upstream_stream_incomplete');
    });
  });
});
