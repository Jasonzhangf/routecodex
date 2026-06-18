import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';

type SseEventRecord = {
  event: string;
  data: unknown;
  raw: string;
  receivedAtMs: number;
};

const mockBridgeModule = () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn((probe: Record<string, unknown> | undefined) => {
    if (!probe?.required_action) {
      return [];
    }
    const submit = (probe.required_action as Record<string, unknown>).submit_tool_outputs as Record<string, unknown> | undefined;
    const calls = Array.isArray(submit?.tool_calls) ? submit.tool_calls as Record<string, unknown>[] : [];
    const call = calls[0] ?? {};
    const callId = String(call.id ?? call.call_id ?? 'call_contract_1');
    const name = String(call.name ?? 'exec_command');
    const args = String(call.arguments ?? '{"cmd":"pwd"}');
    const item = {
      id: `fc_${callId.replace(/^call_/, '')}`,
      type: 'function_call',
      call_id: callId,
      name,
      arguments: args,
      status: 'completed',
    };
    const response = { ...probe, object: 'response', status: 'completed', output: [item] };
    return [
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })}\n\n`,
      `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, call_id: callId, name, arguments: args })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
    ];
  }),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  createResponsesJsonToSseConverter: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => {
      throw new Error('json_to_sse_not_expected_in_this_test');
    },
  })),
  deriveFinishReasonNative: jest.fn(() => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  importCoreDist: jest.fn(async (subpath?: string) => {
    if (subpath === 'native/router-hotpath/native-hub-pipeline-resp-semantics') {
      return {
        projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
          emit: true,
          frame: input.frame,
          state: input.state,
        }),
        projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        projectResponsesClientBodyForClientWithNative: (payload: unknown) => payload,
      };
    }
    return {};
  }),
  isToolCallContinuationResponseNative: jest.fn((body: unknown) => Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && (body as Record<string, unknown>).required_action
  )),
  recordResponsesResponseForRequest: jest.fn(async () => undefined),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  requireCoreDist: jest.fn(() => ({})),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe?: Record<string, unknown>) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    const next = { ...(probe ?? {}) } as Record<string, unknown>;
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return next;
    }
    try {
      const parsed = JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>;
      const response = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
        ? parsed.response as Record<string, unknown>
        : undefined;
      if (response) {
        Object.assign(next, response);
      }
      if (parsed.required_action) {
        next.required_action = parsed.required_action;
      }
    } catch {
      return next;
    }
    return next;
  }),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined,
}));

describe('Responses SSE client contract blackbox', () => {
  const originalProjectionTimeout = process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
  const originalTerminalCloseTimeout = process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
  const originalTotalTimeout = process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = '40';
    process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = '50';
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '1500';
  });

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
    const timeoutMs = options?.timeoutMs ?? 1_000;
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
      const chunkText = decoder.decode(readResult.value, { stream: true });
      pending += chunkText;
      rawText += chunkText;
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

  it('captures required_action -> completed -> done for tool-call continuation without hanging the client', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {
            id: 'resp_tool_call_contract',
            object: 'response',
            status: 'requires_action',
          },
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'tool_calls'
          }
        } as any,
        'req_tool_call_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: response.output_item.done\n');
      upstream.write('data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_contract_1","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}\n\n');
      upstream.write('event: response.completed\n');
      upstream.write('data: {"type":"response.completed","response":{"id":"resp_tool_call_contract","object":"response","status":"completed","output":[{"type":"function_call","id":"call_contract_1","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}]}}\n\n');
      upstream.write('event: response.done\n');
      upstream.write('data: {"type":"response.done","response":{"id":"resp_tool_call_contract","object":"response","status":"completed"}}\n\n');
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { events, rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
        stopOnEvent: 'response.done'
      });
      const names = events.map((entry) => entry.event);
      const outputDoneIndex = names.indexOf('response.output_item.done');
      const completedIndex = names.indexOf('response.completed');
      const doneIndex = names.indexOf('response.done');

      expect(response.status).toBe(200);
      expect(names).not.toContain('response.required_action');
      expect(outputDoneIndex).toBeGreaterThanOrEqual(0);
      expect(completedIndex).toBeGreaterThan(outputDoneIndex);
      expect(doneIndex).toBeGreaterThan(completedIndex);
      expect(rawText).not.toContain('event: error');
      expect(rawText).not.toContain('HTTP_SSE_TIMEOUT');
      expect(rawText).not.toContain('upstream_stream_incomplete');
    });
  });

  it('does not end a non-terminal text stream before upstream terminal events arrive', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {
            id: 'resp_text_contract',
            object: 'response',
            status: 'in_progress'
          },
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'stop'
          }
        } as any,
        'req_text_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: response.output_text.delta\n');
      upstream.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      setTimeout(() => {
        upstream.write('event: response.output_text.delta\n');
        upstream.write('data: {"type":"response.output_text.delta","delta":"second"}\n\n');
        upstream.write('event: response.completed\n');
        upstream.write('data: {"type":"response.completed","response":{"id":"resp_text_contract","object":"response","status":"completed"}}\n\n');
        upstream.write('event: response.done\n');
        upstream.write('data: {"type":"response.done","response":{"id":"resp_text_contract","object":"response","status":"completed"}}\n\n');
        upstream.end();
      }, 120);
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { events, rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
        stopOnEvent: 'response.done'
      });
      const names = events.map((entry) => entry.event);
      const semanticNames = names.filter((name) => name !== 'message');

      expect(response.status).toBe(200);
      expect(semanticNames.slice(0, 2)).toEqual(['ping', 'response.output_text.delta']);
      expect(rawText).toContain('"delta":"first"');
      expect(rawText).toContain('"delta":"second"');
      expect(rawText).not.toContain('response.required_action');
      expect(rawText).not.toContain('event: error');
      expect(semanticNames.indexOf('response.done')).toBeGreaterThan(semanticNames.indexOf('response.completed'));
    });
  });

  it('rejects direct passthrough provider-specific SSE events instead of passing them to Responses clients', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          continuationOwner: 'direct',
          sseStream: upstream,
        } as any,
        'req_direct_nonstandard_event_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: codex.rate_limits\n');
      upstream.write('data: {"type":"codex.rate_limits","limit_reached":true}\n\n');
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
      });

      expect(response.status).toBe(200);
      expect(rawText).toContain('event: error');
      expect(rawText).toContain('RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION');
      expect(rawText).not.toContain('event: codex.rate_limits');
    });
  });

  it('accepts direct passthrough standard Responses custom tool input delta events', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          continuationOwner: 'direct',
          sseStream: upstream,
        } as any,
        'req_direct_custom_tool_input_delta_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: response.custom_tool_call_input.delta\n');
      upstream.write('data: {"type":"response.custom_tool_call_input.delta","item_id":"ctc_123","delta":"ls"}\n\n');
      upstream.write('event: response.completed\n');
      upstream.write('data: {"type":"response.completed","response":{"id":"resp_custom_tool_contract","object":"response","status":"completed"}}\n\n');
      upstream.write('event: response.done\n');
      upstream.write('data: {"type":"response.done","response":{"id":"resp_custom_tool_contract","object":"response","status":"completed"}}\n\n');
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
        stopOnEvent: 'response.done'
      });

      expect(response.status).toBe(200);
      expect(rawText).toContain('event: response.custom_tool_call_input.delta');
      expect(rawText).toContain('"type":"response.custom_tool_call_input.delta"');
      expect(rawText).toContain('event: response.done');
      expect(rawText).not.toContain('RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION');
      expect(rawText).not.toContain('event: error');
    });
  });

  it('drops direct passthrough transport keepalive events but preserves terminal Responses events', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          continuationOwner: 'direct',
          sseStream: upstream,
        } as any,
        'req_direct_keepalive_transport_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: keepalive\n');
      upstream.write('data: {"type":"keepalive"}\n\n');
      upstream.write('event: response.completed\n');
      upstream.write('data: {"type":"response.completed","response":{"id":"resp_keepalive_contract","object":"response","status":"completed"}}\n\n');
      upstream.write('event: response.done\n');
      upstream.write('data: {"type":"response.done","response":{"id":"resp_keepalive_contract","object":"response","status":"completed"}}\n\n');
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
        stopOnEvent: 'response.done'
      });

      expect(response.status).toBe(200);
      expect(rawText).not.toContain('event: keepalive');
      expect(rawText).toContain('event: response.completed');
      expect(rawText).toContain('event: response.done');
      expect(rawText).not.toContain('RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION');
      expect(rawText).not.toContain('event: error');
    });
  });

  it('direct passthrough must not synthesize duplicate tool terminal frames from required_action probe', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          continuationOwner: 'direct',
          sseStream: upstream,
        } as any,
        'req_direct_no_synthetic_terminal_dup',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: response.output_item.added\n');
      upstream.write(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_direct_no_synth',
          type: 'function_call',
          call_id: 'call_direct_no_synth',
          name: 'exec_command',
          arguments: '',
          status: 'in_progress'
        }
      })}\n\n`);
      upstream.write('event: response.function_call_arguments.done\n');
      upstream.write(`data: ${JSON.stringify({
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_direct_no_synth',
        call_id: 'call_direct_no_synth',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      })}\n\n`);
      upstream.write('event: response.output_item.done\n');
      upstream.write(`data: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_direct_no_synth',
          type: 'function_call',
          call_id: 'call_direct_no_synth',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
          status: 'completed'
        }
      })}\n\n`);
      upstream.write('event: response.completed\n');
      upstream.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_direct_no_synth',
          object: 'response',
          status: 'requires_action',
          output: [{
            id: 'fc_direct_no_synth',
            type: 'function_call',
            call_id: 'call_direct_no_synth',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
            status: 'completed'
          }],
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [{
                id: 'call_direct_no_synth',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}'
              }]
            }
          }
        }
      })}\n\n`);
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
      });

      expect(response.status).toBe(200);
      expect((rawText.match(/event: response\.output_item\.added/g) || []).length).toBe(1);
      expect((rawText.match(/event: response\.function_call_arguments\.done/g) || []).length).toBe(1);
      expect((rawText.match(/event: response\.output_item\.done/g) || []).length).toBe(1);
      expect((rawText.match(/event: response\.completed/g) || []).length).toBe(1);
      expect(rawText).not.toContain('event: response.done');
      expect(rawText).not.toContain('event: error');
    });
  });

  it('accepts direct passthrough standard Responses image partial events', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          continuationOwner: 'direct',
          sseStream: upstream,
        } as any,
        'req_direct_image_partial_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: response.image_generation_call.in_progress\n');
      upstream.write('data: {"type":"response.image_generation_call.in_progress","item_id":"ig_123","output_index":0}\n\n');
      upstream.write('event: response.image_generation_call.partial_image\n');
      upstream.write('data: {"type":"response.image_generation_call.partial_image","item_id":"ig_123","output_index":0,"partial_image_b64":"ZmFrZQ==","partial_image_index":0}\n\n');
      upstream.write('event: response.image_generation_call.completed\n');
      upstream.write('data: {"type":"response.image_generation_call.completed","item_id":"ig_123","output_index":0}\n\n');
      upstream.write('event: response.completed\n');
      upstream.write('data: {"type":"response.completed","response":{"id":"resp_image_partial_contract","object":"response","status":"completed"}}\n\n');
      upstream.write('event: response.done\n');
      upstream.write('data: {"type":"response.done","response":{"id":"resp_image_partial_contract","object":"response","status":"completed"}}\n\n');
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
        stopOnEvent: 'response.done'
      });

      expect(response.status).toBe(200);
      expect(rawText).toContain('event: response.image_generation_call.partial_image');
      expect(rawText).toContain('"partial_image_b64":"ZmFrZQ=="');
      expect(rawText).toContain('event: response.done');
      expect(rawText).not.toContain('RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION');
      expect(rawText).not.toContain('event: error');
    });
  });

  it('accepts every standard direct passthrough Responses event from local OpenAI SDK typings', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const sdkResponsesTypings = fs.readFileSync(
      path.join(process.cwd(), 'node_modules/openai/resources/responses/responses.d.ts'),
      'utf8'
    );
    const sdkResponseEvents = [...sdkResponsesTypings.matchAll(/type:\s*'([^']+)'/g)]
      .map((match) => match[1])
      .filter((eventName) => eventName.startsWith('response.'))
      .filter((eventName, index, list) => list.indexOf(eventName) === index);
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          continuationOwner: 'direct',
          sseStream: upstream,
        } as any,
        'req_direct_sdk_events_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      for (const eventName of sdkResponseEvents) {
        upstream.write(`event: ${eventName}\n`);
        upstream.write(`data: ${JSON.stringify({ type: eventName })}\n\n`);
      }
      upstream.write('event: response.done\n');
      upstream.write('data: {"type":"response.done","response":{"id":"resp_sdk_events_contract","object":"response","status":"completed"}}\n\n');
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
        stopOnEvent: 'response.done'
      });

      expect(response.status).toBe(200);
      for (const eventName of sdkResponseEvents) {
        expect(rawText).toContain(`event: ${eventName}`);
      }
      expect(rawText).toContain('event: response.done');
      expect(rawText).not.toContain('RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION');
      expect(rawText).not.toContain('event: error');
    });
  });

  it('turns early upstream close into explicit error instead of client hang', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const app = express();
    app.get('/responses', (_req, res) => {
      const upstream = new PassThrough();
      upstream.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          sseStream: upstream,
        } as any,
        'req_incomplete_contract',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 1500,
        }
      );
      upstream.write('event: response.created\n');
      upstream.write('data: {"type":"response.created","response":{"id":"resp_incomplete_contract","object":"response","status":"in_progress"}}\n\n');
      upstream.write('event: response.output_text.delta\n');
      upstream.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      upstream.end();
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      const { rawText } = await collectSseEvents(response, {
        timeoutMs: 1000,
      });

      expect(response.status).toBe(200);
      expect(rawText).toContain('response.created');
      expect(rawText).toContain('partial');
      expect(rawText).toContain('event: error');
      expect(rawText).toContain('"code":"upstream_stream_incomplete"');
      expect(rawText).not.toContain('response.done');
    });
  });
});
