import { PassThrough, Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { describe, expect, it, jest } from '@jest/globals';

const mockBridgeModule = async () => ({
  createResponsesJsonToSseConverter: jest.fn(),
  assertDirectPassthroughResponsesSseFrameForHttp: jest.fn(),
  buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\nevent: ping\ndata: {"type":"ping"}\n\n'),
  buildResponsesPayloadFromChatForHttp: jest.fn((payload: unknown) => payload),
  buildResponsesTerminalSseFramesFromProbeForHttp: jest.fn((probe: Record<string, unknown> | undefined) => {
    if (!probe?.required_action) return [];
    const response = { ...probe, status: 'requires_action' };
    return [
      `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
    ];
  }),
  clearResponsesConversationByRequestIdForHttpProjection: jest.fn(async () => undefined),
  clearResponsesConversationRequestIdsForHttp: jest.fn(async () => undefined),
  createResponsesJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => Readable.from([])
  })),
  deriveResponsesConversationProviderKeyForHttp: jest.fn(() => undefined),
  finalizeResponsesConversationRequestRetentionForHttp: jest.fn(async () => undefined),
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
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
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
      && (probe as Record<string, unknown>).required_action
    );
    return {
      isToolCallContinuation,
      hasRequiredAction: isToolCallContinuation,
    };
  }),
  planResponsesContinuationCloseActionForHttp: jest.fn((args: {
    entryEndpoint?: string;
    requestContextPresent: boolean;
    probe: unknown;
  }) => {
    const isToolCallContinuation =
      (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs')
      && args.requestContextPresent
      && Boolean(
        args.probe
        && typeof args.probe === 'object'
        && !Array.isArray(args.probe)
        && (args.probe as Record<string, unknown>).required_action
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
      && Boolean(args.probe?.required_action);
    return {
      shouldRepairTerminalFrames: !args.sawResponsesCompletedChunk || !args.sawResponsesDoneEvent,
      shouldRepairContinuationTerminal: !args.sawTerminalEvent && isContinuation,
      shouldProjectIncompleteError: !args.sawTerminalEvent && !isContinuation,
    };
  }),
  isDirectPassthroughTransportKeepaliveFrameForHttp: jest.fn(() => false),
  isToolCallContinuationResponseForHttp: jest.fn((body: unknown) => Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && (body as Record<string, unknown>).required_action
  )),
  requireCoreDist: jest.fn(() => ({})),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn(async ({
    body,
    entryEndpoint,
    hasSsePayload,
  }: {
    body: unknown;
    entryEndpoint?: string;
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
    return record;
  }),
  normalizeResponsesClientPayloadForHttp: jest.fn(async ({ payload }: { payload: unknown }) => payload),
  normalizeResponsesJsonBodyForHttp: jest.fn(async ({ body }: { body: unknown }) => body),
  normalizeResponsesSseFrameForClientForHttp: jest.fn(async ({ frame }: { frame: string }) => {
    if (!frame.includes('response.required_action')) {
      return frame;
    }
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return frame;
    }
    try {
      const parsed = JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>;
      const response = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
        ? parsed.response as Record<string, unknown>
        : {};
      const requiredAction = parsed.required_action && typeof parsed.required_action === 'object' && !Array.isArray(parsed.required_action)
        ? parsed.required_action as Record<string, unknown>
        : {};
      const submitToolOutputs =
        requiredAction.submit_tool_outputs
        && typeof requiredAction.submit_tool_outputs === 'object'
        && !Array.isArray(requiredAction.submit_tool_outputs)
          ? requiredAction.submit_tool_outputs as Record<string, unknown>
          : {};
      const toolCalls = Array.isArray(submitToolOutputs.tool_calls) ? submitToolOutputs.tool_calls : [];
      const firstToolCall =
        toolCalls[0] && typeof toolCalls[0] === 'object' && !Array.isArray(toolCalls[0])
          ? toolCalls[0] as Record<string, unknown>
          : {};
      const callId = typeof firstToolCall.id === 'string' ? firstToolCall.id : 'call_mock';
      const name = typeof firstToolCall.name === 'string' ? firstToolCall.name : 'update_plan';
      const args = typeof firstToolCall.arguments === 'string' ? firstToolCall.arguments : '{}';
      const item = {
        id: `fc_${callId}`,
        type: 'function_call',
        call_id: callId,
        name,
        arguments: args,
        status: 'completed'
      };
      const completedResponse = { ...response, status: 'completed' };
      return [
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item })}\n\n`,
        `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`,
        `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response: completedResponse })}\n\n`
      ].join('');
    } catch {
      return frame;
    }
  }),
  persistResponsesConversationLifecycleForHttp: jest.fn(async () => undefined),
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
      && (args.probe as Record<string, unknown>).required_action
    )
  )),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => null),
  shouldDropClientSseFrameForHttp: jest.fn(() => false),
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
  }) => ({
    finishReason: input.finishReason,
    seenTerminalEvent: input.seenTerminalEvent === true,
    sawTerminalChunk: input.sawTerminalChunk === true,
    sawResponsesCompletedChunk: input.sawResponsesCompletedChunk === true,
    sawResponsesDoneEvent: input.sawResponsesDoneEvent === true,
    sawAssistantMessageDoneTerminal: input.sawAssistantMessageDoneTerminal === true,
    requiresResponsesTerminalEvent: input.requiresResponsesTerminalEvent === true,
    terminalSource: input.terminalSource,
    pendingTerminalEvent: input.pendingTerminalEvent,
  })),
  deriveFinishReasonNative: jest.fn(() => undefined),
  isToolCallContinuationResponseNative: jest.fn((body: unknown) => Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && (body as Record<string, unknown>).required_action
  )),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe: Record<string, unknown> | undefined) => {
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
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn((probe: Record<string, unknown> | undefined) => {
    if (!probe?.required_action) return [];
    const response = { ...probe, status: 'requires_action' };
    return [
      `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
    ];
  }),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  recordResponsesResponseForRequest: jest.fn(async () => undefined),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  updateResponsesContractProbeFromSseChunkForHttp: jest.fn((chunk: unknown, probe: Record<string, unknown> | undefined) => {
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

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.ts', mockBridgeModule);

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.end(JSON.stringify(body));
    return this;
  }
}

async function waitForEndWithTimeout(stream: PassThrough, timeoutMs: number): Promise<boolean> {
  return await Promise.race<boolean>([
    new Promise<boolean>((resolve, reject) => {
      stream.once('end', () => resolve(true));
      stream.once('error', reject);
      stream.resume();
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

describe('handler-response-utils required_action split frame regression', () => {
  it('RED: split response.required_action SSE frames must not terminate before data payload arrives', async () => {
    const previousProjectionTimeout = process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
    const previousTerminalCloseTimeout = process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
    const previousTotalTimeout = process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = '40';
    process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = '50';
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '1500';
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const requestId = 'openai-responses-router-gpt-5.3-codex-native-sse-required-action-split-frame';
    const responseId = 'resp_native_sse_required_action_split_frame_1';
    const callId = 'call_native_sse_required_action_split_frame_1';

    async function* splitRequiredActionStream(): AsyncGenerator<string> {
      yield 'event: response.required_action\n';
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield `data: ${JSON.stringify({
        type: 'response.required_action',
        response: { id: responseId, object: 'response', status: 'requires_action' },
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [{ id: callId, type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"split-frame"}]}' }]
          }
        }
      })}\n\n`;
      await new Promise(() => {});
    }

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));

    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: Readable.from(splitRequiredActionStream()),
          __routecodex_stream_finish_reason: 'tool_calls',
          __routecodex_stream_contract_probe_body: {
            id: responseId,
            object: 'response',
            status: 'requires_action',
            output: [
              {
                type: 'function_call',
                call_id: callId,
                id: `fc_${callId}`,
                name: 'update_plan',
                arguments: '{"plan":[{"step":"split-frame"}]}'
              }
            ],
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [{ id: callId, type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"split-frame"}]}' }]
              }
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'thinking/gateway-priority-5555-thinking',
          sessionId: 'rcc-native-sse-required-action-split-frame'
        },
        metadata: { outboundStream: true }
      } as any,
      requestId,
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.3-codex',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'call update_plan then continue' }] }]
          },
          context: {
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call update_plan then continue' }] }]
          },
          sessionId: 'rcc-native-sse-required-action-split-frame'
        }
      }
    );

    const ended = await waitForEndWithTimeout(res, 1500);
    expect(ended).toBe(true);
    const text = chunks.join('');
    expect(text).toContain('event: response.output_item.added');
    expect(text).toContain('event: response.function_call_arguments.done');
    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('event: response.done');
    expect(text.indexOf('event: response.output_item.done')).toBeLessThan(text.indexOf('event: response.completed'));
    expect(text.indexOf('event: response.completed')).toBeLessThan(text.indexOf('event: response.done'));
    if (previousProjectionTimeout === undefined) {
      delete process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
    } else {
      process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = previousProjectionTimeout;
    }
    if (previousTerminalCloseTimeout === undefined) {
      delete process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
    } else {
      process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = previousTerminalCloseTimeout;
    }
    if (previousTotalTimeout === undefined) {
      delete process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    } else {
      process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = previousTotalTimeout;
    }
  });
});
