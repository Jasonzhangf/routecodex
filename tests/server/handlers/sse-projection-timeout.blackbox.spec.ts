import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';

type BridgeOverrides = Record<string, unknown>;

function createProjectionState() {
  return {
    pendingApplyPatchArgumentDeltas: {},
    applyPatchCallIds: [],
    emittedApplyPatchDoneCallIds: [],
  };
}

function updateTerminalStateFromFrame(input: {
  chunk: unknown;
  state: Record<string, unknown> | undefined;
}): { state: Record<string, unknown>; observedTerminal: boolean } {
  const chunk = typeof input.chunk === 'string' ? input.chunk : '';
  const observedTerminal =
    chunk.includes('event: response.completed')
    || chunk.includes('event: response.done')
    || chunk.includes('data: [DONE]');
  return {
    state: {
      ...(input.state ?? {}),
      observedTerminal: Boolean((input.state ?? {}).observedTerminal) || observedTerminal,
    },
    observedTerminal,
  };
}

function createLocalResponseBridgeMock(overrides: BridgeOverrides = {}): BridgeOverrides {
  return {
    buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
    prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(() => ({ mode: 'json' })),
    normalizeResponsesClientPayloadForHttp: jest.fn((payload: unknown) => payload),
    normalizeResponsesJsonBodyForHttp: jest.fn((payload: unknown) => payload),
    ...overrides,
  };
}

function createLocalSseBridgeMock(overrides: BridgeOverrides = {}): BridgeOverrides {
  return {
    buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\n'),
    createResponsesSseClientProjectionStateForHttp: jest.fn(createProjectionState),
    projectResponsesSseFrameForClientForHttp: jest.fn((input: { frame?: string; state?: unknown }) => ({
      emit: true,
      frame: input.frame ?? '',
      state: input.state,
    })),
    updateResponsesSseTransportTerminalStateForHttp: jest.fn(updateTerminalStateFromFrame),
    ...overrides,
  };
}

function mockBridgeModules(overrides: BridgeOverrides = {}): void {
  const responseBridge = createLocalResponseBridgeMock(overrides);
  const sseBridge = createLocalSseBridgeMock(overrides);
  jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', () => responseBridge);
  jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.js', () => sseBridge);
}

function parseSseEvents(text: string): Array<{ event?: string; data?: unknown }> {
  return text
    .split(/\n\n/)
    .map((block) => {
      const event = block
        .split(/\r?\n/)
        .find((line) => line.startsWith('event: '))
        ?.slice('event: '.length)
        .trim();
      const dataLine = block
        .split(/\r?\n/)
        .find((line) => line.startsWith('data: '));
      if (!event && !dataLine) {
        return null;
      }
      let data: unknown;
      if (dataLine) {
        const rawData = dataLine.slice('data: '.length).trim();
        try {
          data = JSON.parse(rawData);
        } catch {
          data = rawData;
        }
      }
      return { event, data };
    })
    .filter((event): event is { event?: string; data?: unknown } => event !== null);
}

function expectResponsesToolCallContinuationSequence(text: string): void {
  const events = parseSseEvents(text);
  const names = events.map((event) => event.event);
  expect(names).not.toContain('response.required_action');

  const readCallKey = (data: unknown): string | undefined => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return undefined;
    }
    const record = data as Record<string, unknown>;
    if (typeof record.call_id === 'string' && record.call_id.trim()) {
      return record.call_id.trim();
    }
    const item = record.item;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const itemRecord = item as Record<string, unknown>;
      if (typeof itemRecord.call_id === 'string' && itemRecord.call_id.trim()) {
        return itemRecord.call_id.trim();
      }
      if (typeof itemRecord.id === 'string' && itemRecord.id.trim()) {
        return itemRecord.id.trim();
      }
    }
    return undefined;
  };

  let outputAddedIndex = -1;
  let argsDeltaIndex = -1;
  let argsDoneIndex = -1;
  let outputDoneIndex = -1;
  let completedIndex = -1;
  let doneIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.event !== 'response.output_item.added') {
      continue;
    }
    const key = readCallKey(events[index]?.data);
    if (!key) {
      continue;
    }
    const candidateArgsDeltaIndex = events.findIndex((event, candidateIndex) =>
      candidateIndex > index
      && event.event === 'response.function_call_arguments.delta'
      && readCallKey(event.data) === key
    );
    if (candidateArgsDeltaIndex < 0) {
      continue;
    }
    const candidateArgsDoneIndex = events.findIndex((event, candidateIndex) =>
      candidateIndex > candidateArgsDeltaIndex
      && event.event === 'response.function_call_arguments.done'
      && readCallKey(event.data) === key
    );
    if (candidateArgsDoneIndex < 0) {
      continue;
    }
    const candidateOutputDoneIndex = events.findIndex((event, candidateIndex) =>
      candidateIndex > candidateArgsDoneIndex
      && event.event === 'response.output_item.done'
      && readCallKey(event.data) === key
    );
    if (candidateOutputDoneIndex < 0) {
      continue;
    }
    const candidateCompletedIndex = names.findIndex((name, candidateIndex) =>
      candidateIndex > candidateOutputDoneIndex && name === 'response.completed'
    );
    if (candidateCompletedIndex < 0) {
      continue;
    }
    const candidateDoneIndex = names.findIndex((name, candidateIndex) =>
      candidateIndex > candidateCompletedIndex && name === 'response.done'
    );
    if (candidateDoneIndex < 0) {
      continue;
    }
    outputAddedIndex = index;
    argsDeltaIndex = candidateArgsDeltaIndex;
    argsDoneIndex = candidateArgsDoneIndex;
    outputDoneIndex = candidateOutputDoneIndex;
    completedIndex = candidateCompletedIndex;
    doneIndex = candidateDoneIndex;
    break;
  }

  expect({ names }).toEqual(expect.objectContaining({
    names: expect.arrayContaining([
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
      'response.done'
    ])
  }));
  expect(outputAddedIndex).toBeGreaterThanOrEqual(0);
  expect(argsDeltaIndex).toBeGreaterThan(outputAddedIndex);
  expect(argsDoneIndex).toBeGreaterThan(argsDeltaIndex);
  expect(outputDoneIndex).toBeGreaterThan(argsDoneIndex);
  expect(completedIndex).toBeGreaterThan(outputDoneIndex);
  expect(doneIndex).toBeGreaterThan(completedIndex);

  const added = events[outputAddedIndex]?.data as Record<string, unknown>;
  const argsDelta = events[argsDeltaIndex]?.data as Record<string, unknown>;
  const argsDone = events[argsDoneIndex]?.data as Record<string, unknown>;
  const outputDone = events[outputDoneIndex]?.data as Record<string, unknown>;
  const item = outputDone?.item as Record<string, unknown> | undefined;
  expect(added?.type).toBe('response.output_item.added');
  expect(argsDelta?.type).toBe('response.function_call_arguments.delta');
  expect(argsDone?.type).toBe('response.function_call_arguments.done');
  expect(outputDone?.type).toBe('response.output_item.done');
  expect(item?.type).toBe('function_call');
  expect(item?.name).toBe('exec_command');
}

describe('HTTP Responses SSE projection timeout', () => {
  jest.setTimeout(10_000);

  const originalProjectionTimeout = process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
  const originalTerminalCloseTimeout = process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
  const originalTotalTimeout = process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = '40';
    process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = '50';
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '5000';
    jest.resetModules();
  });

  afterEach(() => {
    if (originalProjectionTimeout === undefined) delete process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = originalProjectionTimeout;
    if (originalTerminalCloseTimeout === undefined) delete process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = originalTerminalCloseTimeout;
    if (originalTotalTimeout === undefined) delete process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = originalTotalTimeout;
  });

  it('ends the client SSE response when projected frames never emit a terminal response', async () => {
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '120';
    mockBridgeModules({
      projectResponsesSseFrameForClientForHttp: jest.fn((input: { state?: unknown }) => ({
        emit: false,
        frame: '',
        state: input.state,
      })),
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

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
          body: {},
          sseStream: upstream,
        } as any,
        'req_projection_timeout',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 120,
        }
      );
      upstream.write('event: response.output_text.delta\n');
      upstream.write(
        'data: {"type":"response.output_text.delta","delta":"hello","required_action":{"submit_tool_outputs":{"tool_calls":[{"id":"call_projection_timeout","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}}\n\n'
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const startedAt = Date.now();

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(text).toContain('event: error');
      expect(text).toContain('HTTP_SSE_TIMEOUT');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ends a tool-call continuation SSE stream without waiting for the total timeout', async () => {
    const requiredAction = {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [{
          id: 'call_tool_close_guard',
          type: 'function',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        }]
      }
    };

    mockBridgeModules({
        isToolCallContinuationResponseNative: (body: unknown) => Boolean(
          body
          && typeof body === 'object'
          && !Array.isArray(body)
          && (body as Record<string, unknown>).required_action
        ),
        updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
          const existing =
            probe && typeof probe === 'object' && !Array.isArray(probe)
              ? { ...(probe as Record<string, unknown>) }
              : {};
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : '';
          const dataLine = text
            .split(/\r?\n/)
            .find((line) => line.startsWith('data:'));
          if (!dataLine) {
            return existing;
          }
          const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          const item = payload.item;
          if (
            payload.type === 'response.output_item.done'
            && item
            && typeof item === 'object'
            && !Array.isArray(item)
            && (item as Record<string, unknown>).type === 'function_call'
          ) {
            const toolCall = {
              id: (item as Record<string, unknown>).id ?? 'call_tool_close_guard',
              type: 'function',
              name: (item as Record<string, unknown>).name ?? 'exec_command',
              arguments: (item as Record<string, unknown>).arguments ?? '{}',
              function: {
                name: (item as Record<string, unknown>).name ?? 'exec_command',
                arguments: (item as Record<string, unknown>).arguments ?? '{}',
              }
            };
            return {
              id: 'resp_tool_close_guard',
              status: 'requires_action',
              required_action: {
                type: 'submit_tool_outputs',
                submit_tool_outputs: { tool_calls: [toolCall] }
              },
              output: [{ ...(item as Record<string, unknown>) }]
            };
          }
          return existing;
        },
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'tool_calls'
          }
        } as any,
        'req_terminal_close_guard',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_item.done\n');
      upstream.write('data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_tool_close_guard","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}\n\n');
      upstream.end();
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const startedAt = Date.now();

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('"type":"function_call"');
      expect(text).toContain('"name":"exec_command"');
      expect(text).not.toContain('HTTP_SSE_TIMEOUT');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes through a function-call-only responses stream without SSE-side repair', async () => {
    mockBridgeModules({
        isToolCallContinuationResponseNative: (body: unknown) => Boolean(
          body
          && typeof body === 'object'
          && !Array.isArray(body)
          && (
            (body as Record<string, unknown>).required_action
            || Array.isArray((body as Record<string, unknown>).output)
          )
        ),
        updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
          const existing =
            probe && typeof probe === 'object' && !Array.isArray(probe)
              ? { ...(probe as Record<string, unknown>) }
              : {};
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : '';
          const dataLine = text
            .split(/\r?\n/)
            .find((line) => line.startsWith('data:'));
          if (!dataLine) {
            return existing;
          }
          const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          const item = payload.item;
          if (
            payload.type === 'response.output_item.done'
            && item
            && typeof item === 'object'
            && !Array.isArray(item)
            && (item as Record<string, unknown>).type === 'function_call'
          ) {
            const toolCall = {
              id: (item as Record<string, unknown>).id ?? 'call_probe_from_frame',
              type: 'function',
              name: (item as Record<string, unknown>).name ?? 'exec_command',
              arguments: (item as Record<string, unknown>).arguments ?? '{}',
            };
            return {
              ...existing,
              id: existing.id ?? 'resp_probe_from_frame',
              object: 'response',
              status: 'requires_action',
              required_action: {
                type: 'submit_tool_outputs',
                submit_tool_outputs: {
                  tool_calls: [toolCall]
                }
              },
              output: [{
                type: 'function_call',
                ...toolCall
              }]
            };
          }
          return existing;
        },
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'tool_calls'
          }
        } as any,
        'req_terminal_probe_from_frame',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_item.done\n');
      upstream.write('data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_probe_from_frame","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}\n\n');
      upstream.end();
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const startedAt = Date.now();

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(text).toContain('event: response.output_item.done');
      expect(text).toContain('"type":"function_call"');
      expect(text).toContain('"name":"exec_command"');
      expect(text).not.toContain('HTTP_SSE_TIMEOUT');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not close a non-terminal text stream before the upstream stream ends', async () => {
    mockBridgeModules({
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'stop'
          }
        } as any,
        'req_non_terminal_guard',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_text.delta\n');
      upstream.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      setTimeout(() => {
        upstream.write('event: response.output_text.delta\n');
        upstream.write('data: {"type":"response.output_text.delta","delta":"second"}\n\n');
        upstream.write('event: response.completed\n');
        upstream.write('data: {"type":"response.completed","response":{"id":"resp_non_terminal_guard","object":"response","status":"completed","output_text":"firstsecond"}}\n\n');
        upstream.write('event: response.done\n');
        upstream.write('data: {"type":"response.done","response":{"id":"resp_non_terminal_guard","object":"response","status":"completed","output_text":"firstsecond"}}\n\n');
        upstream.end();
      }, 120);
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(text).toContain('"delta":"first"');
      expect(text).toContain('"delta":"second"');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('SSE_TERMINAL_PROBE_EMPTY');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not synthesize a terminal error when a non-terminal responses stream ends', async () => {
    mockBridgeModules({
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'stop'
          }
        } as any,
        'req_missing_terminal_guard',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_text.delta\n');
      upstream.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      upstream.end();
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(text).toContain('"delta":"partial"');
      expect(text).not.toContain('event: error');
      expect(text).not.toContain('event: response.done');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops on client disconnect and does not persist continuation state for servertool followup', async () => {
    const captureSpy = jest.fn(async () => undefined);
    const recordSpy = jest.fn(async () => undefined);

    mockBridgeModules({
        isToolCallContinuationResponseNative: (body: unknown) => Boolean(
          body
          && typeof body === 'object'
          && !Array.isArray(body)
          && (body as Record<string, unknown>).required_action
        ),
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        captureResponsesConversationToolCallRequestContext: captureSpy,
        recordResponsesConversationToolCallResponse: recordSpy,
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'tool_calls'
          }
        } as any,
        'req_disconnect_guard',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_item.done\n');
      upstream.write('data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_disconnect_guard","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}\n\n');
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;

    try {
      const req = http.get(`http://127.0.0.1:${addr.port}/responses`, {
        headers: { accept: 'text/event-stream' }
      });
      req.on('response', (res) => {
        res.once('data', () => {
          req.destroy();
        });
      });
      await once(req, 'close');
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(captureSpy).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops immediately when the client already disconnected before SSE response wiring starts', async () => {
    const captureSpy = jest.fn(async () => undefined);
    const recordSpy = jest.fn(async () => undefined);

    mockBridgeModules({
        isToolCallContinuationResponseNative: (body: unknown) => Boolean(
          body
          && typeof body === 'object'
          && !Array.isArray(body)
          && (body as Record<string, unknown>).required_action
        ),
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        captureResponsesConversationToolCallRequestContext: captureSpy,
        recordResponsesConversationToolCallResponse: recordSpy,
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const { trackClientConnectionState } = await import('../../../src/server/utils/client-connection-state.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (req, res) => {
      const clientConnectionState = trackClientConnectionState(req as any, res as any);
      setTimeout(() => {
        void sendPipelineResponse(
          res as any,
          {
            status: 200,
            metadata: {
              outboundStream: true,
              stream: true,
              clientConnectionState,
            },
            body: {},
            sseStream: upstream,
            usageLogInfo: {
              requestStartedAtMs: Date.now(),
              finishReason: 'tool_calls'
            }
          } as any,
          'req_disconnect_before_stream_start',
          {
            forceSSE: true,
            entryEndpoint: '/v1/responses',
            sseTotalTimeoutMs: 5000,
          }
        );
      }, 80);
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;

    try {
      const controller = new AbortController();
      const fetchPromise = fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await fetchPromise;
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(upstream.destroyed).toBe(true);
      expect(captureSpy).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not treat timeout-hint disconnect state as pre-start socket close', async () => {
    mockBridgeModules({
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const { trackClientConnectionState } = await import('../../../src/server/utils/client-connection-state.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (req, res) => {
      req.headers['x-request-timeout-ms'] = '5';
      const clientConnectionState = trackClientConnectionState(req as any, res as any);
      setTimeout(() => {
        void sendPipelineResponse(
          res as any,
          {
            status: 200,
            metadata: {
              outboundStream: true,
              stream: true,
              clientConnectionState,
            },
            body: {},
            sseStream: upstream,
            usageLogInfo: {
              requestStartedAtMs: Date.now(),
              finishReason: 'stop'
            }
          } as any,
          'req_timeout_hint_not_prestart_close',
          {
            forceSSE: true,
            entryEndpoint: '/v1/responses',
            sseTotalTimeoutMs: 5000,
          }
        );
        upstream.write('event: response.output_text.delta\n');
        upstream.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
        upstream.write('event: response.completed\n');
        upstream.write('data: {"type":"response.completed","response":{"id":"resp_timeout_hint","object":"response","status":"completed"}}\n\n');
        upstream.write('event: response.done\n');
        upstream.write('data: {"type":"response.done","response":{"id":"resp_timeout_hint","object":"response","status":"completed"}}\n\n');
        upstream.end();
      }, 320);
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(text).toContain('"delta":"hello"');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('direct passthrough does not auto-close a continuation probe before upstream terminal frames arrive', async () => {
    const requiredAction = {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [{
          id: 'call_direct_passthrough_probe',
          type: 'function',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        }]
      }
    };

    mockBridgeModules({
        isToolCallContinuationResponseNative: (body: unknown) => Boolean(
          body
          && typeof body === 'object'
          && !Array.isArray(body)
          && (body as Record<string, unknown>).required_action
        ),
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: {
            outboundStream: true,
            stream: true,
          },
          continuationOwner: 'direct',
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'tool_calls'
          }
        } as any,
        'req_direct_passthrough_probe',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_text.delta\n');
      upstream.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      setTimeout(() => {
        upstream.write('event: response.output_text.delta\n');
        upstream.write('data: {"type":"response.output_text.delta","delta":"second"}\n\n');
        upstream.write('event: response.output_item.added\n');
        upstream.write(`data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: 'fc_direct_passthrough_probe',
            type: 'function_call',
            call_id: 'call_direct_passthrough_probe',
            name: 'exec_command',
            arguments: '',
            status: 'in_progress'
          }
        })}\n\n`);
        upstream.write('event: response.function_call_arguments.delta\n');
        upstream.write(`data: ${JSON.stringify({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_direct_passthrough_probe',
          call_id: 'call_direct_passthrough_probe',
          delta: '{"cmd":"pwd"}'
        })}\n\n`);
        upstream.write('event: response.function_call_arguments.done\n');
        upstream.write(`data: ${JSON.stringify({
          type: 'response.function_call_arguments.done',
          output_index: 0,
          item_id: 'fc_direct_passthrough_probe',
          call_id: 'call_direct_passthrough_probe',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        })}\n\n`);
        upstream.write('event: response.output_item.done\n');
        upstream.write(`data: ${JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'fc_direct_passthrough_probe',
            type: 'function_call',
            call_id: 'call_direct_passthrough_probe',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
            status: 'completed'
          }
        })}\n\n`);
        upstream.write('event: response.completed\n');
        upstream.write('data: {"type":"response.completed","response":{"id":"resp_direct_passthrough_probe","object":"response","status":"completed"}}\n\n');
        upstream.write('event: response.done\n');
        upstream.write('data: {"type":"response.done","response":{"id":"resp_direct_passthrough_probe","object":"response","status":"completed"}}\n\n');
        upstream.end();
      }, 120);
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const startedAt = Date.now();

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
      expect(text).toContain('"delta":"first"');
      expect(text).toContain('"delta":"second"');
      expectResponsesToolCallContinuationSequence(text);
      expect(text).not.toContain('SSE_TERMINAL_PROBE_EMPTY');
      expect(text).not.toContain('SSE_CLIENT_PROJECTION_TIMEOUT');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes after a real terminal event without turning an empty probe repair into an error', async () => {
    mockBridgeModules({
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        writeSnapshotViaHooks: async () => undefined,
    });
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const upstream = new PassThrough();
    upstream.on('error', () => {});
    const app = express();
    app.get('/responses', (_req, res) => {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          metadata: { outboundStream: true, stream: true },
          body: {},
          sseStream: upstream,
          usageLogInfo: {
            requestStartedAtMs: Date.now(),
            finishReason: 'stop'
          }
        } as any,
        'req_terminal_empty_probe_guard',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.done\n');
      upstream.write('data: {"type":"response.done"}\n\n');
      upstream.end();
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const startedAt = Date.now();

    try {
      const response = await fetch(`http://127.0.0.1:${addr.port}/responses`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('SSE_TERMINAL_PROBE_EMPTY');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
