import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

describe('responses-handler SSE terminal contract', () => {
  type SseEventRecord = {
    event: string;
    data: unknown;
    raw: string;
    receivedAtMs: number;
  };

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

  async function collectSseEvents(
    response: Response,
    options?: { timeoutMs?: number; stopOnEvent?: string }
  ): Promise<{ events: SseEventRecord[]; rawText: string }> {
    const timeoutMs = options?.timeoutMs ?? 1_500;
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const events: SseEventRecord[] = [];
    let rawText = '';
    let pending = '';
    const startedAt = Date.now();

    while (true) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(`SSE stream did not reach ${options?.stopOnEvent ?? 'EOF'} within ${timeoutMs}ms.\n${rawText}`);
      }

      const readResult = await Promise.race([
        reader!.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`SSE stream timed out after ${timeoutMs}ms.\n${rawText}`)), remainingMs);
        })
      ]);

      if (readResult.done) {
        break;
      }

      pending += decoder.decode(readResult.value, { stream: true });
      rawText += decoder.decode(readResult.value);
      const frames = pending.split('\n\n');
      pending = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.trim()) {
          continue;
        }
        const lines = frame.split('\n');
        const eventLine = lines.find((line) => line.startsWith('event: '));
        const dataLines = lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length));
        const event = eventLine ? eventLine.slice('event: '.length).trim() : 'message';
        const rawData = dataLines.join('\n');
        let data: unknown = rawData;
        try {
          data = rawData ? JSON.parse(rawData) : rawData;
        } catch {
          data = rawData;
        }
        events.push({
          event,
          data,
          raw: frame,
          receivedAtMs: Date.now() - startedAt,
        });
        if (options?.stopOnEvent && event === options.stopOnEvent) {
          await reader!.cancel();
          return { events, rawText };
        }
      }
    }

    return { events, rawText };
  }

  it('HTTP blackbox: streams response.done after response.completed without upstream_stream_incomplete', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: true, stream: true },
      sseStream: Readable.from([
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
      const { events, rawText: text } = await collectSseEvents(response, {
        timeoutMs: 1_500,
        stopOnEvent: 'response.done'
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      expect(events.map((entry) => entry.event)).toEqual(expect.arrayContaining([
        'response.completed',
        'response.done'
      ]));
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });

  it('HTTP blackbox: upstream closes without response.done — handler does not synthesize response.done', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: true, stream: true },
      sseStream: Readable.from([
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
          // NOTE: No response.done - simulates upstream timeout/close before terminal event
        ])
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
      const { events, rawText: text } = await collectSseEvents(response, {
        timeoutMs: 1_500,
        stopOnEvent: 'response.required_action'
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/event-stream');
      expect(events.map((entry) => entry.event)).toEqual(expect.arrayContaining([
        'response.completed'
      ]));
      expect(text).toContain('event: response.completed');
      expect(text).not.toContain('event: response.done');
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });

  it('HTTP blackbox: upstream required_action without response.completed is projected and closed by Rust owner', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: true, stream: true },
      body: {
        id: 'resp_required_only',
        object: 'response',
        status: 'requires_action',
      },
      sseStream: Readable.from([
        'event: response.required_action\n',
        `data: ${JSON.stringify({
          type: 'response.required_action',
          response: { id: 'resp_required_only', object: 'response', status: 'requires_action' },
          required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [{ id: 'call_1', type: 'function_call', function: { name: 'shell', arguments: '{}' } }] } }
        })}\n\n`
      ]),
      usageLogInfo: { finishReason: 'tool_calls' }
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
      const { events, rawText: text } = await collectSseEvents(response, {
        timeoutMs: 1_500
      });
      const eventNames = events.map((entry) => entry.event);

      expect(response.status).toBe(200);
      expect(eventNames).not.toContain('response.required_action');
      expect(text).not.toContain('event: response.required_action');
      expect(text).toContain('event: response.output_item.added');
      expect(text).toContain('event: response.function_call_arguments.delta');
      expect(text).toContain('event: response.function_call_arguments.done');
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).toContain('data: [DONE]');
      expect(text.indexOf('event: response.output_item.done')).toBeLessThan(text.indexOf('event: response.completed'));
      expect(text.indexOf('event: response.completed')).toBeLessThan(text.indexOf('event: response.done'));
      expect(text.indexOf('event: response.done')).toBeLessThan(text.indexOf('data: [DONE]'));
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });

  it('HTTP blackbox negative: non-terminal stream must not synthesize required_action/completed/done before upstream actually emits terminal events', async () => {
    const executePipeline = jest.fn(async () => ({
      status: 200,
      headers: {},
      metadata: { outboundStream: true, stream: true },
      sseStream: Readable.from([
          'event: response.output_text.delta\n',
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'first' })}\n\n`,
          'event: response.output_text.delta\n',
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'second' })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_text_1', object: 'response', status: 'completed', output_text: 'firstsecond' }
          })}\n\n`,
          'event: response.done\n',
          `data: ${JSON.stringify({
            type: 'response.done',
            response: { id: 'resp_text_1', object: 'response', status: 'completed', output_text: 'firstsecond' }
          })}\n\n`
        ])
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
        body: JSON.stringify({ model: 'gpt-5.5', stream: true, input: 'write text' })
      });
      const { events, rawText: text } = await collectSseEvents(response, {
        timeoutMs: 1_500,
        stopOnEvent: 'response.done'
      });
      const eventNames = events.map((entry) => entry.event);
      const signalEvents = eventNames.filter((event) => event !== 'message' && event !== 'ping');

      expect(response.status).toBe(200);
      expect(signalEvents.slice(0, 2)).toEqual(['response.output_text.delta', 'response.output_text.delta']);
      expect(eventNames).not.toContain('response.required_action');
      expect(signalEvents.indexOf('response.completed')).toBeGreaterThan(1);
      expect(signalEvents.indexOf('response.done')).toBeGreaterThan(signalEvents.indexOf('response.completed'));
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('event: error');
    });
  });
});
