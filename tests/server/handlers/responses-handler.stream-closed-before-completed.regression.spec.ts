import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';

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

function findSseDataByType(text: string, type: string): Record<string, unknown> | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice('data: '.length);
    if (raw === '[DONE]') continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === type) return parsed;
  }
  return undefined;
}

function createMockCoreDistProjectionModule() {
  return {
    projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
      emit: true,
      frame: input.frame,
      state: input.state,
    }),
    projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
  };
}

function updateProbeFromChunk(chunk: unknown, probe: unknown): Record<string, unknown> {
  const next = { ...((probe && typeof probe === 'object' && !Array.isArray(probe)) ? probe as Record<string, unknown> : {}) };
  const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const eventName = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length).trim() ?? '';
    const dataText = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (!dataText || dataText === '[DONE]') continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(dataText) as Record<string, unknown>;
    } catch {
      continue;
    }
    const parsedType = typeof parsed.type === 'string' ? parsed.type : '';
    const response = parsed.response as Record<string, unknown> | undefined;
    if (response) {
      if (typeof response.id === 'string') next.id = response.id;
      if (typeof response.status === 'string') next.status = response.status;
      if (Array.isArray(response.output)) next.output = response.output;
      if (typeof response.output_text === 'string') next.output_text = response.output_text;
    }
    if (eventName === 'response.completed' || parsedType === 'response.completed') {
      next.__seen_response_completed = true;
    }
    if (eventName === 'response.done' || parsedType === 'response.done') {
      next.__seen_response_done = true;
    }
    if (eventName === 'response.required_action' || parsedType === 'response.required_action') {
      next.__seen_response_required_action = true;
      if (parsed.required_action && typeof parsed.required_action === 'object') {
        next.required_action = parsed.required_action;
      }
    }
    if (eventName === 'response.output_item.done' || parsedType === 'response.output_item.done') {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item && typeof item === 'object') {
        const output = Array.isArray(next.output) ? [...next.output as unknown[]] : [];
        const itemId = typeof item.id === 'string' ? item.id : undefined;
        const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
        const existingIndex = output.findIndex((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
          const row = entry as Record<string, unknown>;
          return (itemId && row.id === itemId) || (callId && row.call_id === callId);
        });
        if (existingIndex >= 0) {
          output[existingIndex] = item;
        } else {
          output.push(item);
        }
        next.output = output;
        if (item.type === 'message' && item.role === 'assistant' && item.status === 'completed') {
          next.status = 'completed';
        }
      }
    }
  }
  return next;
}

function buildTerminalFrames(probe: unknown): string[] {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return [];
  const row = probe as Record<string, unknown>;
  const outputItems = Array.isArray(row.output) ? row.output as Record<string, unknown>[] : [];
  const synthesizedToolCalls = outputItems
    .filter((item) => item && typeof item === 'object' && item.type === 'function_call')
    .map((item) => ({
      id: typeof item.call_id === 'string' && item.call_id.trim() ? item.call_id : item.id,
      type: 'function_call',
      name: item.name,
      arguments: item.arguments ?? ''
    }));
  const effectiveRequiredAction = row.required_action ?? (
    synthesizedToolCalls.length > 0
      ? {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: synthesizedToolCalls
          }
        }
      : undefined
  );
  const response = {
    id: typeof row.id === 'string' ? row.id : 'resp_test_probe',
    object: 'response',
    status: effectiveRequiredAction ? 'requires_action' : (typeof row.status === 'string' ? row.status : 'completed'),
    ...(Array.isArray(row.output) ? { output: row.output } : {}),
    ...(typeof row.output_text === 'string' ? { output_text: row.output_text } : {}),
  };
  const frames: string[] = [];
  if (effectiveRequiredAction && !row.__seen_response_required_action) {
    frames.push(`event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: effectiveRequiredAction })}\n\n`);
  }
  if (!row.__seen_response_completed) {
    frames.push(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
  }
  if (!row.__seen_response_done) {
    frames.push(`event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`);
  }
  return frames;
}

async function loadSendPipelineResponse() {
  jest.resetModules();
  jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
    captureResponsesRequestContextForRequest: async () => undefined,
    clearResponsesConversationByRequestId: async () => undefined,
    finalizeResponsesConversationRequestRetention: async () => undefined,
    recordResponsesResponseForRequest: async () => undefined,
    rebindResponsesConversationRequestId: async () => undefined,
    createResponsesJsonToSseConverter: async () => ({
      convertResponseToJsonToSse: async () => {
        throw new Error('json_to_sse_not_expected_in_this_test');
      }
    }),
    deriveFinishReasonNative: () => undefined,
    isToolCallContinuationResponseNative: () => false,
    updateResponsesContractProbeFromSseChunkNative: updateProbeFromChunk,
    buildResponsesTerminalSseFramesFromProbeNative: buildTerminalFrames,
    importCoreDist: async () => createMockCoreDistProjectionModule(),
    requireCoreDist: () => ({}),
  }));
  jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
    isSnapshotsEnabled: () => false,
    writeServerSnapshot: async () => undefined
  }));
  const mod = await import('../../../src/server/handlers/handler-response-utils.js');
  return mod.sendPipelineResponse;
}

async function collectSseEvents(
  response: Response,
  options?: { timeoutMs?: number; stopOnEvent?: string }
): Promise<{ rawText: string; events: string[] }> {
  const timeoutMs = options?.timeoutMs ?? 1_500;
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  const events: string[] = [];
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
      if (!frame.trim()) continue;
      const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice('event: '.length).trim() ?? 'message';
      events.push(event);
      if (options?.stopOnEvent && event === options.stopOnEvent) {
        await reader!.cancel();
        return { rawText, events };
      }
    }
  }
  return { rawText, events };
}

describe('responses-handler stream closed before completed regression', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('repairs terminal Responses SSE frames with a response id when upstream emits output item then closes', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.output_item.done\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_terminal_probe_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'OK' }]
            }
          })}\n\n`
        );
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_repair_terminal_probe',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();
      const completedEvent = findSseDataByType(text, 'response.completed');
      const doneEvent = findSseDataByType(text, 'response.done');

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(completedEvent?.response).toEqual(expect.objectContaining({ id: expect.any(String) }));
      expect(doneEvent?.response).toEqual(expect.objectContaining({ id: expect.any(String) }));
    });
  });

  it('surfaces started-stream failure as explicit SSE error when upstream closes before response.completed', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.created\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.created',
            response: {
              id: 'resp_stream_closed_1',
              object: 'response',
              status: 'in_progress',
              model: 'gpt-5.3-codex',
              output: []
            }
          })}\n\n`
        );
        upstream.write('event: response.output_text.delta\n');
        upstream.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`);
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_stream_closed_started',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('response.created');
      expect(text).toContain('partial');
      expect(text).not.toContain('event: response.completed');
      expect(text).toContain('event: error');
      expect(text).toContain('"code":"upstream_stream_incomplete"');
      expect(text).toContain('stream closed before response.completed');
    });
  });

  it('treats upstream response.failed as terminal and does not append stream-incomplete error', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.failed\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.failed',
            response: {
              id: 'resp_failed_terminal_1',
              object: 'response',
              status: 'failed',
              error: {
                code: 'rate_limit_error',
                message: 'Concurrency limit exceeded for user, please retry later'
              }
            }
          })}\n\n`
        );
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_response_failed_terminal',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.failed');
      expect(text).toContain('rate_limit_error');
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });

  it('auto-closes a hung stream when assistant response.output_item.done is the last terminal signal', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.created\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.created',
            response: {
              id: 'resp_terminal_only_message',
              object: 'response',
              status: 'in_progress',
              output: [{
                id: 'msg_terminal_only_message',
                type: 'message',
                role: 'assistant',
                status: 'in_progress',
                content: [{ type: 'output_text', text: 'partial' }]
              }]
            }
          })}\n\n`
        );
        upstream.write('event: response.output_item.done\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_terminal_only_message',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done' }]
            }
          })}\n\n`
        );
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true
          }
        } as any,
        'req_terminal_only_message',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const { rawText: text, events } = await collectSseEvents(response, {
        timeoutMs: 2_000,
        stopOnEvent: 'response.done'
      });
      const completedEvent = findSseDataByType(text, 'response.completed');
      expect(response.status).toBe(200);
      expect(events).toEqual(expect.arrayContaining([
        'response.output_item.done',
        'response.completed',
        'response.done'
      ]));
      expect(completedEvent?.response).toEqual(expect.objectContaining({
        id: 'resp_terminal_only_message',
        status: 'completed'
      }));
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
    });
  });

  it('repairs tool continuation terminal frames when upstream closes after function call output items', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/v1/responses', async (_req, res) => {
      const upstream = new PassThrough();
      setTimeout(() => {
        upstream.write('event: response.output_item.added\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_stream_closed_tool_1',
              type: 'function_call',
              call_id: 'call_stream_closed_tool_1',
              name: 'ping_tool',
              arguments: ''
            }
          })}\n\n`
        );
        upstream.write('event: response.function_call_arguments.done\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.function_call_arguments.done',
            item_id: 'fc_stream_closed_tool_1',
            output_index: 0,
            arguments: '{\"value\":\"ok\"}'
          })}\n\n`
        );
        upstream.write('event: response.output_item.done\n');
        upstream.write(
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_stream_closed_tool_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_stream_closed_tool_1',
              name: 'ping_tool',
              arguments: '{\"value\":\"ok\"}'
            }
          })}\n\n`
        );
        upstream.end();
      }, 10);

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true,
          },
          continuationOwner: 'relay',
        } as any,
        'req_stream_closed_tool_continuation',
        { entryEndpoint: '/v1/responses' }
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          accept: 'text/event-stream'
        }
      });
      const text = await response.text();
      const completedEvent = findSseDataByType(text, 'response.completed');
      const doneEvent = findSseDataByType(text, 'response.done');

      expect(response.status).toBe(200);
      expect(text).toContain('event: response.output_item.added');
      expect(text).toContain('event: response.function_call_arguments.done');
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('upstream_stream_incomplete');
      expect(text).not.toContain('stream closed before response.completed');
      expect(completedEvent?.response).toEqual(expect.objectContaining({
        id: expect.any(String),
        output: expect.any(Array)
      }));
      expect(doneEvent?.response).toEqual(expect.objectContaining({
        id: expect.any(String),
        output: expect.any(Array)
      }));
    });
  });

});
