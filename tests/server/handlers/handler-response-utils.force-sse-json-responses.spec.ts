import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

const mockBridgeModule = async () => ({
  assertDirectPassthroughResponsesSseFrameForHttp: jest.fn(),
  buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\nevent: ping\ndata: {"type":"ping"}\n\n'),
  buildResponsesPayloadFromChatForHttp: jest.fn(async (payload: unknown) => ({
    id: 'resp_chat_bridge_mock',
    object: 'response',
    status: 'completed',
    output: [
      {
        id: 'msg_chat_bridge_mock',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK' }]
      }
    ],
    _source: payload
  })),
  buildResponsesTerminalSseFramesFromProbeForHttp: jest.fn((probe: Record<string, unknown> | undefined) => {
    if (!probe) return [];
    const response = { ...probe, status: (probe.status as string | undefined) ?? 'completed' };
    return [
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
    ];
  }),
  captureResponsesRequestContextForHttpProjection: jest.fn(async () => undefined),
  clearResponsesConversationByRequestIdForHttpProjection: jest.fn(async () => undefined),
  clearResponsesConversationRequestIdsForHttp: jest.fn(async () => undefined),
  createResponsesJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async (payload: Record<string, unknown>) => {
      const responseId = typeof payload.id === 'string' ? payload.id : '';
      if (!responseId) {
        throw new Error('RESPONSE_CONVERSION_ERROR: Invalid ResponsesResponse: missing required fields');
      }
      const chunks: string[] = [
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId, status: 'in_progress' } })}\n\n`
      ];
      const output = Array.isArray(payload.output) ? payload.output : [];
      for (const item of output) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (record.type === 'function_call') {
          chunks.push(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: record })}\n\n`);
          chunks.push(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: record.id, output_index: 0, arguments: record.arguments ?? '{}' })}\n\n`);
          chunks.push(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: record })}\n\n`);
        } else if (record.type === 'message') {
          chunks.push(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: record })}\n\n`);
          chunks.push(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: record })}\n\n`);
        }
      }
      chunks.push(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, status: 'completed' } })}\n\n`);
      chunks.push(`event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response: { id: responseId, status: 'completed' } })}\n\n`);
      return Readable.from(chunks);
    }
  })),
  finalizeResponsesConversationRequestRetentionForHttp: jest.fn(async () => undefined),
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
  inspectResponsesTerminalStateFromSseChunkForHttp: jest.fn((input: {
    chunk: unknown;
    finishReason?: string;
    seenTerminalEvent?: boolean;
    sawTerminalChunk?: boolean;
    sawResponsesCompletedChunk?: boolean;
    sawResponsesDoneEvent?: boolean;
    sawAssistantMessageDoneTerminal?: boolean;
    requiresResponsesTerminalEvent?: boolean;
    terminalSource?: string;
    pendingTerminalEvent?: string;
  }) => {
    const text = typeof input.chunk === 'string' ? input.chunk : String(input.chunk ?? '');
    return {
      finishReason:
        text.includes('response.completed') || text.includes('response.done')
          ? (input.finishReason ?? 'stop')
          : input.finishReason,
      seenTerminalEvent:
        input.seenTerminalEvent === true || text.includes('response.completed') || text.includes('response.done'),
      sawTerminalChunk:
        input.sawTerminalChunk === true || text.includes('response.completed') || text.includes('response.done'),
      sawResponsesCompletedChunk:
        input.sawResponsesCompletedChunk === true || text.includes('response.completed'),
      sawResponsesDoneEvent:
        input.sawResponsesDoneEvent === true || text.includes('response.done'),
      sawAssistantMessageDoneTerminal: input.sawAssistantMessageDoneTerminal === true,
      requiresResponsesTerminalEvent: input.requiresResponsesTerminalEvent === true,
      terminalSource: input.terminalSource ?? (text.includes('response.done') ? 'response.done' : text.includes('response.completed') ? 'response.completed' : undefined),
      pendingTerminalEvent: undefined,
    };
  }),
  inspectResponsesContinuationProbeForHttp: jest.fn((args: {
    entryEndpoint?: string;
    probe: unknown;
  }) => {
    if (args.entryEndpoint !== '/v1/responses' && args.entryEndpoint !== '/v1/responses.submit_tool_outputs') {
      return { isToolCallContinuation: false, hasRequiredAction: false };
    }
    const probe = args.probe;
    const isToolCallContinuation = Boolean(
      probe
      && typeof probe === 'object'
      && !Array.isArray(probe)
      && Array.isArray((probe as Record<string, unknown>).output)
      && ((probe as Record<string, unknown>).output as unknown[]).some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')
    );
    return {
      isToolCallContinuation,
      hasRequiredAction: isToolCallContinuation && Boolean(
        probe
        && typeof probe === 'object'
        && !Array.isArray(probe)
        && (probe as Record<string, unknown>).required_action
      ),
    };
  }),
  planResponsesContinuationCloseActionForHttp: jest.fn((args: {
    entryEndpoint?: string;
    requestContextPresent: boolean;
    probe: unknown;
  }) => {
    const probe = args.probe;
    const isToolCallContinuation =
      (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs')
      && args.requestContextPresent
      && Boolean(
        probe
        && typeof probe === 'object'
        && !Array.isArray(probe)
        && Array.isArray((probe as Record<string, unknown>).output)
        && ((probe as Record<string, unknown>).output as unknown[]).some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')
      );
    return isToolCallContinuation
      ? { action: 'persist_continuation', keepForSubmitToolOutputs: true }
      : { action: 'clear_abandoned', keepForSubmitToolOutputs: false };
  }),
  planResponsesStreamEndRepairForHttp: jest.fn((args: {
    entryEndpoint?: string;
    probe: Record<string, unknown> | undefined;
    sawResponsesCompletedChunk: boolean;
    sawResponsesDoneEvent: boolean;
    sawTerminalEvent: boolean;
  }) => {
    const isContinuation =
      (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs')
      && Boolean(
        args.probe
        && Array.isArray(args.probe.output)
        && args.probe.output.some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')
      );
    return {
      shouldRepairTerminalFrames: !args.sawResponsesCompletedChunk || !args.sawResponsesDoneEvent,
      shouldRepairContinuationTerminal: !args.sawTerminalEvent && isContinuation,
      shouldProjectIncompleteError: !args.sawTerminalEvent && !isContinuation,
    };
  }),
  isDirectPassthroughTransportKeepaliveFrameForHttp: jest.fn((frame: string) => frame.includes('event: keepalive')),
  isToolCallContinuationResponseForHttp: jest.fn((body: unknown) => Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && Array.isArray((body as Record<string, unknown>).output)
    && ((body as Record<string, unknown>).output as unknown[]).some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')
  )),
  normalizeResponsesClientPayloadForHttp: jest.fn(async ({ payload }: { payload: unknown }) => payload),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn(async ({
    body,
    entryEndpoint,
    requestLabel,
    hasSsePayload,
  }: {
    body: unknown;
    entryEndpoint?: string;
    requestLabel?: string;
    hasSsePayload: (value: unknown) => boolean;
  }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || hasSsePayload(body)) {
      return null;
    }
    const record = body as Record<string, unknown>;
    if (
      (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
      && (record.object === 'response' || typeof record.output === 'object' || typeof record.status === 'string')
    ) {
      return record;
    }
    if (entryEndpoint !== '/v1/responses' || record.object !== 'chat.completion') {
      return null;
    }
    return {
      id: 'resp_chat_bridge_mock',
      object: 'response',
      status: 'completed',
      output: [
        {
          id: 'msg_chat_bridge_mock',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'OK' }]
        }
      ],
      _source: body,
      _requestId: requestLabel,
    };
  }),
  normalizeResponsesJsonBodyForHttp: jest.fn(async ({
    body,
    entryEndpoint,
    requestLabel,
    resolveBridge
  }: {
    body: unknown;
    entryEndpoint?: string;
    requestLabel?: string;
    resolveBridge?: () => Promise<{ buildResponsesPayloadFromChat?: (payload: unknown, context?: Record<string, unknown>) => unknown }>;
  }) => {
    if (entryEndpoint !== '/v1/responses') {
      return body;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return body;
    }
    if ((body as Record<string, unknown>).object !== 'chat.completion') {
      return body;
    }
    const mod = await (resolveBridge
      ? resolveBridge()
      : Promise.resolve({
          buildResponsesPayloadFromChat: (payload: unknown) => payload
        }));
    if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
      throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
    }
    return mod.buildResponsesPayloadFromChat(body, { requestId: requestLabel });
  }),
  normalizeResponsesSseFrameForClientForHttp: jest.fn(async ({ frame }: { frame: string }) => frame),
  persistResponsesConversationLifecycleForHttp: jest.fn(async () => undefined),
  projectResponsesClientPayloadForClientForHttp: jest.fn(async ({ payload }: { payload: unknown }) => payload),
  projectResponsesSseFrameForClientForHttp: jest.fn(async ({ frame }: { frame: string }) => ({ emit: true, frame, state: undefined })),
  recordResponsesResponseForHttpProjection: jest.fn(async () => undefined),
  rebindResponsesConversationRequestIdForHttp: jest.fn(async () => undefined),
  requireResponsesHandlerCoreDist: jest.fn(() => ({})),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(() => 'openai-responses'),
  shouldRepairResponsesContinuationTerminalForHttp: jest.fn((args: {
    entryEndpoint?: string;
    probe: unknown;
  }) => (
    (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs')
    && Boolean(
      args.probe
      && typeof args.probe === 'object'
      && !Array.isArray(args.probe)
      && Array.isArray((args.probe as Record<string, unknown>).output)
      && ((args.probe as Record<string, unknown>).output as unknown[]).some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')
    )
  )),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => null),
  shouldDropClientSseFrameForHttp: jest.fn(() => false),
  updateResponsesContractProbeFromSseChunkForHttp: jest.fn((chunk: unknown, probe?: Record<string, unknown>) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    const next = { ...(probe ?? {}) } as Record<string, unknown>;
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return next;
    try {
      const parsed = JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>;
      const response = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
        ? parsed.response as Record<string, unknown>
        : undefined;
      if (response) Object.assign(next, response);
      if (parsed.required_action) next.required_action = parsed.required_action;
    } catch {}
    return next;
  }),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.ts', mockBridgeModule);
jest.unstable_mockModule('../../../src/server/utils/finish-reason.js', () => ({
  STREAM_LOG_FINISH_REASON_KEY: '__stream_log_finish_reason',
  deriveFinishReason: (body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return undefined;
    }
    const record = body as Record<string, unknown>;
    const output = Array.isArray(record.output) ? record.output : [];
    if (output.some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')) {
      return 'tool_calls';
    }
    const status = typeof record.status === 'string' ? record.status : undefined;
    if (status === 'completed' || status === 'stop') {
      return 'stop';
    }
    if (record.object === 'chat.completion') {
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const finishReason = choices
        .map((choice) => choice && typeof choice === 'object' && !Array.isArray(choice)
          ? (choice as Record<string, unknown>).finish_reason
          : undefined)
        .find((value) => typeof value === 'string');
      return typeof finishReason === 'string' ? finishReason : undefined;
    }
    return undefined;
  },
}));
jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined
}));

async function loadSendPipelineResponse() {
  const mod = await import('../../../src/server/handlers/handler-response-utils.js');
  return mod.sendPipelineResponse;
}

async function loadNormalizeResponsesJsonBodyForHttp() {
  const mod = await import('../../../src/modules/llmswitch/bridge/responses-response-bridge.js');
  return mod.normalizeResponsesJsonBodyForHttp;
}

describe('handler-response-utils forceSSE responses json bridge', () => {
  it('keeps direct raw SSE frames on the same client-frame metadata guard', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-sse-with-provider-metadata', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: Readable.from([
              'event: response.created\n',
              'data: {"type":"response.created","response":{"id":"resp_direct_meta","metadata":{"provider":"raw"}}}\n\n',
              'event: response.completed\n',
              'data: {"type":"response.completed","response":{"id":"resp_direct_meta","metadata":{"provider":"raw"}}}\n\n',
            ]),
          },
          metadata: {
            outboundStream: true,
            __routecodexDirectPassthrough: true,
          },
          usageLogInfo: {
            routeName: 'router-direct:thinking',
            requestStartedAtMs: Date.now(),
          },
        } as any,
        'req_direct_sse_provider_metadata',
        { entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/direct-sse-with-provider-metadata`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('"metadata":{"provider":"raw"}');
      expect(text).not.toContain('sse_bridge_error');
      expect(text).not.toContain('internal carrier');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects direct raw SSE frames that carry internal metadata controls', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-sse-with-internal-metadata', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: Readable.from([
              'event: response.created\n',
              'data: {"type":"response.created","response":{"id":"resp_direct_meta","metadata":{"routeHint":"tools"}}}\n\n',
            ]),
          },
          metadata: {
            outboundStream: true,
            __routecodexDirectPassthrough: true,
          },
          usageLogInfo: {
            routeName: 'router-direct:thinking',
            requestStartedAtMs: Date.now(),
          },
        } as any,
        'req_direct_sse_internal_metadata',
        { entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/direct-sse-with-internal-metadata`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(text).toContain('sse_stream_error');
      expect(text).toContain('SSE stream response projection failed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps direct responses JSON function_call payload unchanged and never projects servertool CLI', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-json-function-call', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'resp_direct_json_tool',
            object: 'response',
            status: 'completed',
            output: [
              {
                id: 'fc_direct_json_tool',
                type: 'function_call',
                call_id: 'call_direct_json_tool',
                name: 'stop_message_auto',
                arguments: '{"flowId":"stop_message_flow"}',
                status: 'completed'
              }
            ]
          },
          metadata: {
            __routecodexDirectPassthrough: true,
          },
        } as any,
        'req_direct_json_function_call',
        { entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/direct-json-function-call`);
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(JSON.stringify(body)).toContain('"name":"stop_message_auto"');
      expect(JSON.stringify(body)).not.toContain('routecodex servertool run');
      expect(JSON.stringify(body)).not.toContain('"name":"exec_command"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps direct raw SSE function_call frames unchanged and never projects servertool CLI', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-sse-function-call', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: Readable.from([
              'event: response.output_item.done\n',
              'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_direct_sse_tool","call_id":"call_direct_sse_tool","name":"stop_message_auto","arguments":"{\\"flowId\\":\\"stop_message_flow\\"}"}}\n\n',
              'event: response.completed\n',
              'data: {"type":"response.completed","response":{"id":"resp_direct_sse_tool","status":"completed"}}\n\n',
              'event: response.done\n',
              'data: {"type":"response.done","response":{"id":"resp_direct_sse_tool","status":"completed"}}\n\n',
            ]),
          },
          metadata: {
            outboundStream: true,
            __routecodexDirectPassthrough: true,
          },
          usageLogInfo: {
            routeName: 'router-direct:thinking',
            requestStartedAtMs: Date.now(),
          },
        } as any,
        'req_direct_sse_function_call',
        { entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/direct-sse-function-call`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('"name":"stop_message_auto"');
      expect(text).not.toContain('routecodex servertool run');
      expect(text).not.toContain('"name":"exec_command"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('encodes JSON responses payload into client-visible SSE instead of sse_bridge_error', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
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

  it('encodes Responses function_call JSON into complete SSE terminal frames', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/responses-sse-from-tool-json', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'resp_tool_json_bridge_1',
            object: 'response',
            status: 'completed',
            model: 'gpt-5.4-medium',
            output: [
              {
                id: 'fc_json_bridge_1',
                type: 'function_call',
                call_id: 'call_json_bridge_1',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}',
                status: 'completed'
              }
            ]
          }
        } as any,
        'req_force_sse_tool_json_bridge',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses-sse-from-tool-json`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('event: response.output_item.added');
      expect(text).toContain('event: response.function_call_arguments.done');
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('stream closed before response.completed');
      expect(text).not.toContain('sse_stream_error');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects Responses JSON-to-SSE payloads without response id before emitting response.completed', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/responses-sse-missing-id', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            object: 'response',
            status: 'completed',
            model: 'gpt-5.4-medium',
            output: []
          }
        } as any,
        'req_force_sse_missing_id',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses-sse-missing-id`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('event: error');
      expect(text).not.toContain('event: response.completed');
      expect(text).not.toContain('"type":"response.completed"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('encodes chat.completion JSON into /v1/responses SSE instead of sse_bridge_error', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
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
    const normalizeResponsesJsonBodyForHttp = await loadNormalizeResponsesJsonBodyForHttp();
    const normalized = await normalizeResponsesJsonBodyForHttp({
      body: {
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
      entryEndpoint: '/v1/responses',
      requestLabel: 'req_json_dispatch_chat_bridge',
      resolveBridge: (async () => ({
        buildResponsesPayloadFromChat: (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          object: 'response',
          status: 'completed',
          output: []
        })
      })) as any
    }) as Record<string, unknown>;

    expect(normalized.object).toBe('response');
    expect(normalized.object).not.toBe('chat.completion');
    expect(normalized.status).toBe('completed');
    expect(JSON.stringify(normalized)).not.toContain('chat.completion');
  });
});
