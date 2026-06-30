import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const finalizeRetentionMock = jest.fn(async (_requestId: string, _options?: unknown) => undefined);

const __resetFinalizeMock = () => {
  finalizeRetentionMock.mockClear();
};

const mockBridgeModule = async () => ({
  assertDirectPassthroughResponsesSseFrameForHttp: jest.fn(),
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp: jest.fn(),
  buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
  buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\n'),
  buildResponsesMissingSseBridgeErrorPayloadForHttp: jest.fn((requestLabel: string, status = 502) => ({
    type: 'error',
    status,
    error: {
      message: 'SSE stream missing from pipeline result',
      code: 'sse_bridge_error',
      request_id: requestLabel,
    },
  })),
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
  createChatJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async (payload: Record<string, unknown>) => {
      const responseId = typeof payload.id === 'string' ? payload.id : 'chatcmpl_mock';
      const model = typeof payload.model === 'string' ? payload.model : 'gpt-5.4-mini';
      const usage = payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
        ? payload.usage as Record<string, unknown>
        : undefined;
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      const message =
        choice && typeof choice === 'object' && !Array.isArray(choice)
          ? (choice as Record<string, unknown>).message
          : undefined;
      const content =
        message && typeof message === 'object' && !Array.isArray(message)
          ? (message as Record<string, unknown>).content
          : '';
      const text = typeof content === 'string' ? content : '';
      return Readable.from([
        `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null
            }
          ]
        })}\n\n`,
        `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: null
            }
          ]
        })}\n\n`,
        ...(usage
          ? [
              `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: 1,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                  }
                ],
                usage
              })}\n\n`
            ]
          : []),
        `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }
          ]
        })}\n\n`,
        'data: [DONE]\n\n'
      ]);
    }
  })),
  buildResponsesSseErrorPayloadForHttp: jest.fn((args: {
    requestLabel: string;
    status: number;
    message: string;
    code: string;
    error?: Record<string, unknown>;
  }) => ({
    type: 'error',
    status: args.status,
    error: {
      ...(args.error ?? {}),
      message: args.message,
      code: args.code,
      request_id: args.requestLabel,
    },
  })),
  buildResponsesStreamIncompleteErrorPayloadForHttp: jest.fn((requestLabel: string) => ({
    type: 'error',
    status: 502,
    error: {
      message: 'stream closed before response.completed',
      code: 'upstream_stream_incomplete',
      request_id: requestLabel,
    },
  })),
  buildResponsesStructuredSseErrorPayloadForHttp: jest.fn((args: {
    body: unknown;
    requestLabel: string;
    status: number;
  }) => {
    const record = args.body && typeof args.body === 'object' && !Array.isArray(args.body)
      ? args.body as Record<string, unknown>
      : undefined;
    const error = record?.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : undefined;
    if (!error) {
      return null;
    }
    return {
      type: 'error',
      status: args.status,
      error: {
        ...error,
        request_id: typeof error.request_id === 'string' ? error.request_id : args.requestLabel,
      },
    };
  }),
  clearResponsesConversationRequestIdsForHttp: jest.fn(async () => undefined),
  sanitizeDirectPassthroughResponsesSseFrameForHttp: jest.fn((frame: string) => frame),
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
  resolveResponsesRequestContextForHttp: jest.fn((args: {
    metadata?: unknown;
    fallback?: Record<string, unknown>;
  }) => {
    const metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? args.metadata as Record<string, unknown>
      : undefined;
    const requestContext = metadata?.responsesRequestContext;
    return requestContext && typeof requestContext === 'object' && !Array.isArray(requestContext)
      ? requestContext
      : args.fallback;
  }),
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
  normalizeChatUsagePayloadForHttp: jest.fn((body: unknown, options?: { entryEndpoint?: string; usageFallback?: Record<string, unknown> }) => {
    const entryEndpoint = typeof options?.entryEndpoint === 'string' ? options.entryEndpoint : '';
    const isChat = entryEndpoint.toLowerCase().includes('/v1/chat/completions');
    const fallback = options?.usageFallback;
    if (
      isChat
      && body
      && typeof body === 'object'
      && !Array.isArray(body)
      && fallback
      && typeof fallback === 'object'
      && !Array.isArray(fallback)
    ) {
      return {
        payload: {
          ...(body as Record<string, unknown>),
          usage: {
            ...(fallback as Record<string, unknown>),
          }
        },
        normalized: true,
        source: 'usage_log',
      };
    }
    return {
      payload: body,
      normalized: false,
      source: undefined,
    };
  }),
  resolveResponsesTerminalProbeFinishReasonForHttp: jest.fn((args: {
    finishReason?: string;
    probe: unknown;
  }) => {
    if (typeof args.finishReason === 'string' && args.finishReason.trim()) {
      return args.finishReason.trim();
    }
    const probe = args.probe;
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
      return undefined;
    }
    const response =
      (probe as Record<string, unknown>).response
      && typeof (probe as Record<string, unknown>).response === 'object'
      && !Array.isArray((probe as Record<string, unknown>).response)
        ? (probe as Record<string, unknown>).response as Record<string, unknown>
        : undefined;
    const finishReason = response?.finish_reason ?? (probe as Record<string, unknown>).finish_reason;
    return typeof finishReason === 'string' && finishReason.trim() ? finishReason.trim() : undefined;
  }),
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
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(async (args: {
    body: unknown;
  }) => ({
    clientBody: args.body,
    sanitizedBody: args.body,
    finishReason:
      args.body
      && typeof args.body === 'object'
      && !Array.isArray(args.body)
      && Array.isArray((args.body as Record<string, unknown>).output)
      && ((args.body as Record<string, unknown>).output as unknown[]).some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
  })),
  shouldDispatchResponsesSseToClientForHttp: jest.fn((args: {
    body: unknown;
    forceSSE: boolean;
    metadata?: Record<string, unknown>;
  }) => {
    if (args.forceSSE) {
      return true;
    }
    if (!args.body || typeof args.body !== 'object' || !('sseStream' in (args.body as Record<string, unknown>))) {
      return false;
    }
    return MetadataCenter.read(args.metadata)?.readRuntimeControl().streamIntent === 'stream';
  }),
  shouldClearResponsesConversationOnClientCloseForHttp: jest.fn((args: {
    entryEndpoint?: string;
    closeBeforeStreamEnd: boolean;
  }) => args.closeBeforeStreamEnd && args.entryEndpoint === '/v1/responses'),
  shouldClearResponsesConversationOnFailureForHttp: jest.fn((args: {
    entryEndpoint?: string;
    status: number;
    phase: 'sse_stream_error' | 'sse_incomplete' | 'json_empty' | 'json';
  }) => {
    if (args.entryEndpoint !== '/v1/responses' && args.entryEndpoint !== '/v1/responses.submit_tool_outputs') {
      return false;
    }
    if (args.phase === 'sse_stream_error' || args.phase === 'sse_incomplete') {
      return true;
    }
    return args.status >= 400;
  }),
  shouldRequireResponsesTerminalEventForHttp: jest.fn((args: {
    entryEndpoint?: string;
    probe: unknown;
  }) => (
    Boolean(args.probe)
    && (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs')
  )),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn(async ({
    body,
    entryEndpoint,
    requestLabel,
  }: {
    body: unknown;
    entryEndpoint?: string;
    requestLabel?: string;
  }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
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
  projectResponsesSseFrameForClientForHttp: jest.fn(async ({ frame }: { frame: string }) => ({ emit: true, frame, state: undefined })),
  rebindResponsesConversationRequestIdForHttp: jest.fn(async () => undefined),
  requireResponsesHandlerCoreDist: jest.fn(() => ({})),
  resolveResponsesClientPayloadFinishReasonForHttp: jest.fn((payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return undefined;
    }
    const record = payload as Record<string, unknown>;
    const output = Array.isArray(record.output) ? record.output : [];
    if (output.some((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call')) {
      return 'tool_calls';
    }
    return typeof record.status === 'string' && (record.status === 'completed' || record.status === 'stop')
      ? 'stop'
      : undefined;
  }),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(() => 'openai-responses'),
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

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.ts', mockBridgeModule);
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
  const mod = await import('../../../src/modules/llmswitch/bridge/responses-sse-bridge.js');
  return mod.normalizeResponsesJsonBodyForHttp;
}

describe('handler-response-utils forceSSE responses json bridge', () => {
  it('keeps direct raw SSE frames with provider metadata unchanged', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-sse-with-provider-metadata', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: Readable.from([
              'event: response.created\n',
              'data: {"type":"response.created","response":{"id":"resp_direct_meta","metadata":{"provider":"raw"}}}\n\n',
              'event: response.completed\n',
              'data: {"type":"response.completed","response":{"id":"resp_direct_meta","metadata":{"provider":"raw"}}}\n\n',
            ]),
          metadata: {
            outboundStream: true,
          },
          continuationOwner: 'direct',
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
      expect(text).toContain('event: response.created');
      expect(text).toContain('event: response.completed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps direct raw SSE frames with metadata controls unchanged because SSE is transport-only', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-sse-with-internal-metadata', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: Readable.from([
              'event: response.created\n',
              'data: {"type":"response.created","response":{"id":"resp_direct_meta","metadata":{"routeHint":"tools"}}}\n\n',
            ]),
          metadata: {
            outboundStream: true,
          },
          continuationOwner: 'direct',
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
      expect(response.status).toBe(200);
      expect(text).toContain('"metadata":{"routeHint":"tools"}');
      expect(text).toContain('event: response.created');
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
          },
          continuationOwner: 'direct',
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
          sseStream: Readable.from([
              'event: response.output_item.done\n',
              'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_direct_sse_tool","call_id":"call_direct_sse_tool","name":"stop_message_auto","arguments":"{\\"flowId\\":\\"stop_message_flow\\"}"}}\n\n',
              'event: response.completed\n',
              'data: {"type":"response.completed","response":{"id":"resp_direct_sse_tool","status":"completed"}}\n\n',
              'event: response.done\n',
              'data: {"type":"response.done","response":{"id":"resp_direct_sse_tool","status":"completed"}}\n\n',
            ]),
          metadata: {
            outboundStream: true,
          },
          continuationOwner: 'direct',
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

  it('keeps direct raw SSE terminal required_action and reasoning truth unchanged', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-sse-required-action-reasoning', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: Readable.from([
              'event: response.reasoning_summary_text.done\n',
              'data: {"type":"response.reasoning_summary_text.done","item_id":"rs_direct_sse_tool","text":"need cwd before patch"}\n\n',
              'event: response.completed\n',
              `data: ${JSON.stringify({
                type: 'response.completed',
                response: {
                  id: 'resp_direct_sse_reasoning_tool',
                  object: 'response',
                  status: 'requires_action',
                  output: [
                    {
                      id: 'rs_direct_sse_tool',
                      type: 'reasoning',
                      summary: [{ type: 'summary_text', text: 'need cwd before patch' }],
                    },
                    {
                      id: 'fc_direct_sse_tool',
                      type: 'function_call',
                      call_id: 'call_direct_sse_tool',
                      name: 'exec_command',
                      arguments: '{"cmd":"pwd"}',
                      status: 'in_progress',
                    }
                  ],
                  required_action: {
                    type: 'submit_tool_outputs',
                    submit_tool_outputs: {
                      tool_calls: [
                        {
                          id: 'call_direct_sse_tool',
                          type: 'function_call',
                          name: 'exec_command',
                          arguments: '{"cmd":"pwd"}',
                        }
                      ]
                    }
                  }
                }
              })}\n\n`,
              `event: response.done\n`,
              `data: ${JSON.stringify({
                type: 'response.done',
                response: {
                  id: 'resp_direct_sse_reasoning_tool',
                  object: 'response',
                  status: 'requires_action',
                  output: [
                    {
                      id: 'rs_direct_sse_tool',
                      type: 'reasoning',
                      summary: [{ type: 'summary_text', text: 'need cwd before patch' }],
                    },
                    {
                      id: 'fc_direct_sse_tool',
                      type: 'function_call',
                      call_id: 'call_direct_sse_tool',
                      name: 'exec_command',
                      arguments: '{"cmd":"pwd"}',
                      status: 'in_progress',
                    }
                  ],
                  required_action: {
                    type: 'submit_tool_outputs',
                    submit_tool_outputs: {
                      tool_calls: [
                        {
                          id: 'call_direct_sse_tool',
                          type: 'function_call',
                          name: 'exec_command',
                          arguments: '{"cmd":"pwd"}',
                        }
                      ]
                    }
                  }
                }
              })}\n\n`,
            ]),
          metadata: {
            outboundStream: true,
          },
          continuationOwner: 'direct',
          usageLogInfo: {
            routeName: 'router-direct:tools',
            requestStartedAtMs: Date.now(),
          },
        } as any,
        'req_direct_sse_required_action_reasoning',
        { entryEndpoint: '/v1/responses' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/direct-sse-required-action-reasoning`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('response.reasoning_summary_text.done');
      expect(text).toContain('"need cwd before patch"');
      expect(text).toContain('"status":"requires_action"');
      expect(text).toContain('"call_direct_sse_tool"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects forceSSE JSON responses payload without Rust-produced SSE stream', async () => {
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
      expect(text).toContain('event: error');
      expect(text).toContain('sse_bridge_error');
      expect(text).toContain('SSE stream missing from pipeline result');
      expect(text).not.toContain('event: response.created');
      expect(text).not.toContain('event: response.completed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not start forceSSE JSON bridge writes when no Rust SSE stream exists', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();

    const app = express();
    app.get('/responses-sse-from-slow-json', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'resp_json_bridge_close_1',
            object: 'response',
            status: 'completed',
            output: []
          }
        } as any,
        'req_force_sse_json_bridge_close',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );
    });
    app.get('/healthz', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses-sse-from-slow-json`, {
        headers: { accept: 'text/event-stream' }
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      const firstText = Buffer.from(first.value ?? []).toString('utf8');
      expect(first.done).toBe(false);
      expect(firstText).toContain('event: error');
      expect(firstText).toContain('sse_bridge_error');
      expect(firstText).not.toContain('response.created');
      await reader!.cancel();
      await new Promise((resolve) => setTimeout(resolve, 180));

      const health = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects Responses function_call JSON when forceSSE lacks Rust-produced SSE stream', async () => {
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
      expect(text).toContain('event: error');
      expect(text).toContain('sse_bridge_error');
      expect(text).not.toContain('event: response.output_item.added');
      expect(text).not.toContain('event: response.function_call_arguments.done');
      expect(text).not.toContain('event: response.output_item.done');
      expect(text).not.toContain('event: response.completed');
      expect(text).not.toContain('event: response.done');
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

  it('rejects chat.completion JSON for /v1/responses forceSSE without Rust-produced SSE stream', async () => {
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
      expect(text).toContain('event: error');
      expect(text).toContain('sse_bridge_error');
      expect(text).not.toContain('event: response.created');
      expect(text).not.toContain('event: response.completed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects chat.completion JSON for /v1/chat/completions forceSSE without Rust-produced SSE stream', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/chat-sse-from-chat-json', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'chatcmpl_force_sse_1',
            object: 'chat.completion',
            model: 'glm-5.1',
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
        'req_force_sse_chat_completions_bridge',
        { forceSSE: true, entryEndpoint: '/v1/chat/completions' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/chat-sse-from-chat-json`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('sse_bridge_error');
      expect(text).not.toContain('data: {"id":"chatcmpl_force_sse_1"');
      expect(text).not.toContain('"object":"chat.completion.chunk"');
      expect(text).not.toContain('[DONE]');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not project chat usage fallback through TS JSON-to-SSE conversion', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    app.get('/direct-chat-sse-usage-fallback', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            id: 'chatcmpl_usage_fallback',
            object: 'chat.completion',
            model: 'glm-5.2',
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
          metadata: {
            outboundStream: true,
          },
          continuationOwner: 'direct',
          usageLogInfo: {
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20
            },
            routeName: 'router-direct:thinking',
            requestStartedAtMs: Date.now(),
          },
        } as any,
        'req_direct_chat_sse_usage_fallback',
        { forceSSE: true, entryEndpoint: '/v1/chat/completions' }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/direct-chat-sse-usage-fallback`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('sse_bridge_error');
      expect(text).not.toContain('"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}');
      expect(text).not.toContain('"object":"chat.completion.chunk"');
      expect(text).not.toContain('[DONE]');
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

describe('handler-response-utils submit_tool_outputs SSE normal-end retention', () => {
  beforeEach(() => {
    __resetFinalizeMock();
  });

  it('relay submit_tool_outputs follow-up requires_action retains the request id after a normal SSE end', async () => {
    const sendPipelineResponse = await loadSendPipelineResponse();
    const app = express();
    const requestLabel = 'openai-responses-router-stopless-submit-2';
    app.get('/responses-sse-submit-tool-outputs-retention', (_req, res) => {
      void sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: Readable.from([
            'event: response.created\n',
            'data: {"type":"response.created","response":{"id":"resp_submit_2_followup","status":"in_progress"}}\n\n',
            'event: response.output_item.added\n',
            'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_submit_2","call_id":"call_submit_2","name":"reasoningStop","arguments":"{\\"flowId\\":\\"stop_message_flow\\"}"}}\n\n',
            'event: response.function_call_arguments.done\n',
            'data: {"type":"response.function_call_arguments.done","item_id":"fc_submit_2","output_index":0,"arguments":"{\\"flowId\\":\\"stop_message_flow\\"}"}\n\n',
            'event: response.output_item.done\n',
            'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_submit_2","call_id":"call_submit_2","name":"reasoningStop","arguments":"{\\"flowId\\":\\"stop_message_flow\\"}","status":"in_progress"}}\n\n',
            'event: response.required_action\n',
            `data: ${JSON.stringify({
              type: 'response.required_action',
              response: {
                id: 'resp_submit_2_followup',
                object: 'response',
                status: 'requires_action',
                output: [
                  {
                    id: 'fc_submit_2',
                    type: 'function_call',
                    call_id: 'call_submit_2',
                    name: 'reasoningStop',
                    arguments: '{"flowId":"stop_message_flow"}',
                    status: 'in_progress'
                  }
                ],
                required_action: {
                  type: 'submit_tool_outputs',
                  submit_tool_outputs: {
                    tool_calls: [
                      {
                        id: 'call_submit_2',
                        type: 'function_call',
                        name: 'reasoningStop',
                        arguments: '{"flowId":"stop_message_flow"}'
                      }
                    ]
                  }
                }
              },
              required_action: {
                type: 'submit_tool_outputs',
                submit_tool_outputs: {
                  tool_calls: [
                    {
                      id: 'call_submit_2',
                      type: 'function_call',
                      name: 'reasoningStop',
                      arguments: '{"flowId":"stop_message_flow"}'
                    }
                  ]
                }
              }
            })}\n\n`,
            'event: response.completed\n',
            'data: {"type":"response.completed","response":{"id":"resp_submit_2_followup","status":"requires_action"}}\n\n',
            'event: response.done\n',
            'data: {"type":"response.done","response":{"id":"resp_submit_2_followup","status":"requires_action"}}\n\n'
          ]),
          metadata: {
            outboundStream: true,
            responsesRequestContext: {
              payload: { model: 'gpt-5.4-mini', store: true, input: [] },
              context: { input: [] },
              sessionId: 'sess_submit_2',
              conversationId: 'conv_submit_2',
              providerKey: 'router-stopless.gpt-5.4-mini'
            }
          },
          continuationOwner: 'relay',
          usageLogInfo: {
            routeName: 'thinking',
            timingRequestIds: [requestLabel]
          }
        } as any,
        requestLabel,
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responsesRequestContext: {
            payload: { model: 'gpt-5.4-mini', store: true, input: [] },
            context: { input: [] },
            sessionId: 'sess_submit_2',
            conversationId: 'conv_submit_2',
            providerKey: 'router-stopless.gpt-5.4-mini'
          }
        }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses-sse-submit-tool-outputs-retention`, {
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('"status":"requires_action"');
      expect(text).toContain('event: response.done');
      expect(text).toContain('"resp_submit_2_followup"');
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
