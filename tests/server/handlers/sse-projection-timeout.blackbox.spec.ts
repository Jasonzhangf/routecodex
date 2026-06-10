import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createBridgeHttpServerMock } from '../../helpers/bridge-http-server-mock.js';

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

  it('ends the client SSE response when frame projection stalls', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
        importCoreDist: async () => new Promise(() => {}),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
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
          body: {
            __sse_responses: upstream,
          },
        } as any,
        'req_projection_timeout',
        {
          forceSSE: true,
          entryEndpoint: '/v1/responses',
          sseTotalTimeoutMs: 5000,
        }
      );
      upstream.write('event: response.output_text.delta\n');
      upstream.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
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
      expect(text).toContain('event: error');
      expect(text).toContain('SSE_CLIENT_PROJECTION_TIMEOUT');
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

    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
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
        buildResponsesTerminalSseFramesFromProbeNative: (probe: unknown) => {
          if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
            return [];
          }
          const record = probe as Record<string, unknown>;
          if (!record.required_action) {
            return [];
          }
          const responsePayload = {
            id: record.id ?? 'resp_tool_close_guard',
            object: 'response',
            status: 'requires_action',
            required_action: record.required_action
          };
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response: responsePayload, required_action: record.required_action })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responsePayload })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response: responsePayload })}\n\n`
          ];
        },
        importCoreDist: async () => ({
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        }),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { STREAM_CONTRACT_PROBE_BODY_KEY } = await import(
      '../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js'
    );
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
          body: {
            __sse_responses: upstream,
            __routecodex_finish_reason: 'tool_calls',
            [STREAM_CONTRACT_PROBE_BODY_KEY]: {
              id: 'resp_tool_close_guard',
              status: 'requires_action',
              required_action: requiredAction
            }
          },
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
      expect(text).toContain('event: response.required_action');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('HTTP_SSE_TIMEOUT');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not close a non-terminal text stream before the upstream stream ends', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        buildResponsesTerminalSseFramesFromProbeNative: () => [],
        importCoreDist: async () => ({
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        }),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { STREAM_CONTRACT_PROBE_BODY_KEY } = await import(
      '../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js'
    );
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
          body: {
            __sse_responses: upstream,
            [STREAM_CONTRACT_PROBE_BODY_KEY]: {
              id: 'resp_non_terminal_guard',
              status: 'in_progress',
              output_text: 'first'
            }
          },
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

  it('stops on client disconnect and does not persist continuation state for servertool followup', async () => {
    const captureSpy = jest.fn(async () => undefined);
    const recordSpy = jest.fn(async () => undefined);

    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
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
        buildResponsesTerminalSseFramesFromProbeNative: () => [],
        captureResponsesConversationToolCallRequestContext: captureSpy,
        recordResponsesConversationToolCallResponse: recordSpy,
        importCoreDist: async () => ({
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        }),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { STREAM_CONTRACT_PROBE_BODY_KEY } = await import(
      '../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js'
    );
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
          body: {
            __sse_responses: upstream,
            __routecodex_finish_reason: 'tool_calls',
            [STREAM_CONTRACT_PROBE_BODY_KEY]: {
              id: 'resp_disconnect_guard',
              status: 'requires_action',
              required_action: {
                type: 'submit_tool_outputs',
                submit_tool_outputs: {
                  tool_calls: [{
                    id: 'call_disconnect_guard',
                    type: 'function',
                    name: 'exec_command',
                    arguments: '{"cmd":"pwd"}'
                  }]
                }
              }
            }
          },
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

    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
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
        buildResponsesTerminalSseFramesFromProbeNative: () => [],
        captureResponsesConversationToolCallRequestContext: captureSpy,
        recordResponsesConversationToolCallResponse: recordSpy,
        importCoreDist: async () => ({
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        }),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { STREAM_CONTRACT_PROBE_BODY_KEY } = await import(
      '../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js'
    );
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
            body: {
              __sse_responses: upstream,
              __routecodex_finish_reason: 'tool_calls',
              [STREAM_CONTRACT_PROBE_BODY_KEY]: {
                id: 'resp_disconnect_before_stream_start',
                status: 'requires_action',
                required_action: {
                  type: 'submit_tool_outputs',
                  submit_tool_outputs: {
                    tool_calls: [{
                      id: 'call_disconnect_before_stream_start',
                      type: 'function',
                      name: 'exec_command',
                      arguments: '{"cmd":"pwd"}'
                    }]
                  }
                }
              }
            },
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

    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
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
        buildResponsesTerminalSseFramesFromProbeNative: (probe: unknown) => {
          if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
            return [];
          }
          const record = probe as Record<string, unknown>;
          if (!record.required_action) {
            return [];
          }
          const responsePayload = {
            id: record.id ?? 'resp_direct_passthrough_probe',
            object: 'response',
            status: 'requires_action',
            required_action: record.required_action
          };
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response: responsePayload, required_action: record.required_action })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responsePayload })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response: responsePayload })}\n\n`
          ];
        },
        importCoreDist: async () => ({
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        }),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { STREAM_CONTRACT_PROBE_BODY_KEY } = await import(
      '../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js'
    );
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
            __routecodexDirectPassthrough: true,
          },
          body: {
            __sse_responses: upstream,
            [STREAM_CONTRACT_PROBE_BODY_KEY]: {
              id: 'resp_direct_passthrough_probe',
              status: 'requires_action',
              required_action: requiredAction
            }
          },
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
        upstream.write('event: response.required_action\n');
        upstream.write(`data: ${JSON.stringify({
          type: 'response.required_action',
          response: {
            id: 'resp_direct_passthrough_probe',
            object: 'response',
            status: 'requires_action',
            required_action: requiredAction
          },
          required_action: requiredAction
        })}\n\n`);
        upstream.write('event: response.completed\n');
        upstream.write('data: {"type":"response.completed","response":{"id":"resp_direct_passthrough_probe","object":"response","status":"requires_action"}}\n\n');
        upstream.write('event: response.done\n');
        upstream.write('data: {"type":"response.done","response":{"id":"resp_direct_passthrough_probe","object":"response","status":"requires_action"}}\n\n');
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
      expect(text).toContain('event: response.required_action');
      expect(text).toContain('event: response.done');
      expect(text).not.toContain('SSE_TERMINAL_PROBE_EMPTY');
      expect(text).not.toContain('SSE_CLIENT_PROJECTION_TIMEOUT');
      expect(text).not.toContain('event: error');
    } finally {
      upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes after a real terminal event without turning an empty probe repair into an error', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () =>
      createBridgeHttpServerMock({
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => (
          probe && typeof probe === 'object' && !Array.isArray(probe)
            ? probe
            : {}
        ),
        buildResponsesTerminalSseFramesFromProbeNative: () => [],
        importCoreDist: async () => ({
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        }),
        writeSnapshotViaHooks: async () => undefined,
      })
    );
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
          body: {
            __sse_responses: upstream,
          },
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
