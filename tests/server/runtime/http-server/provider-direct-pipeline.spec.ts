import { describe, expect, it, jest } from '@jest/globals';
import {
  detectInboundProtocolFromRequest,
  executeProviderDirectPipeline,
} from '../../../../src/server/runtime/http-server/provider-direct-pipeline.js';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';

function createHandle(protocol: ProviderHandle['providerProtocol']) {
  const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
    status: 200,
    body: payload,
  }));
  const processIncomingDirect = jest.fn(async (payload: Record<string, unknown>) => ({
    status: 200,
    body: payload,
    direct: true,
  }));
  const handle: ProviderHandle = {
    runtimeKey: `runtime.${protocol}`,
    providerId: 'mock',
    providerType: 'mock',
    providerFamily: 'mock',
    providerProtocol: protocol,
    runtime: {} as any,
    instance: {
      initialize: async () => {},
      cleanup: async () => {},
      processIncoming,
      processIncomingDirect,
    },
  };
  return { handle, processIncoming, processIncomingDirect };
}

describe('provider-direct-pipeline', () => {
  it('fails fast when direct mode crosses protocols', async () => {
    const { handle } = createHandle('anthropic-messages');
    await expect(
      executeProviderDirectPipeline(
        { messages: [{ role: 'user', content: 'hello' }] },
        { path: '/v1/chat/completions', headers: {} },
        {
          portConfig: {
            port: 5000,
            host: '127.0.0.1',
            mode: 'provider',
            protocolBehavior: 'direct',
            providerBinding: 'mock.model',
          },
          resolveProvider: () => handle,
          detectInboundProtocol: detectInboundProtocolFromRequest,
        },
      ),
    ).rejects.toThrow(/protocolBehavior=direct requires matching protocols/i);
  });

  it('auto mode relays cross-protocol payloads and remaps system messages', async () => {
    const { handle, processIncoming } = createHandle('anthropic-messages');
    const result = await executeProviderDirectPipeline(
      {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
      },
      { path: '/v1/chat/completions', headers: {} },
      {
        portConfig: {
          port: 5001,
          host: '127.0.0.1',
          mode: 'provider',
          protocolBehavior: 'auto',
          providerBinding: 'mock.model',
        },
        resolveProvider: () => handle,
        detectInboundProtocol: detectInboundProtocolFromRequest,
      },
    );

    expect(result.actualBehavior).toBe('relay');
    expect(processIncoming).toHaveBeenCalledTimes(1);
    expect(processIncoming).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'system prompt',
        stream: true,
        max_tokens: 4096,
      }),
    );
    const sentPayload = processIncoming.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Array.isArray(sentPayload.messages)).toBe(true);
    expect((sentPayload.messages as Array<Record<string, unknown>>).some((entry) => entry.role === 'system')).toBe(false);
  });

  it('fails fast when relay would require an unsupported cross-protocol semantic map', async () => {
    const { handle } = createHandle('openai-chat');
    await expect(
      executeProviderDirectPipeline(
        {
          messages: [{ role: 'user', content: 'hello' }],
        },
        { path: '/v1/chat/completions', headers: {} },
        {
          portConfig: {
            port: 5002,
            host: '127.0.0.1',
            mode: 'provider',
            protocolBehavior: 'auto',
            providerBinding: 'mock.model',
          },
          resolveProvider: () => handle,
          detectInboundProtocol: () => 'unknown-protocol' as any,
        },
      ),
    ).rejects.toThrow(/relay only supports openai-chat <-> anthropic-messages today/i);
  });

  it('keeps openai-responses same-protocol requests on direct path in auto mode', async () => {
    const { handle, processIncoming, processIncomingDirect } = createHandle('openai-responses');
    const requestPayload = {
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      reasoning: { effort: 'high' },
    } as Record<string, unknown>;
    const beforeSnapshots: Array<Record<string, unknown>> = [];
    const afterSnapshots: unknown[] = [];

    const result = await executeProviderDirectPipeline(
      requestPayload,
      { path: '/v1/responses', headers: {} },
      {
        portConfig: {
          port: 5003,
          host: '127.0.0.1',
          mode: 'provider',
          protocolBehavior: 'auto',
          providerBinding: 'mock.model',
        },
        resolveProvider: () => handle,
        detectInboundProtocol: detectInboundProtocolFromRequest,
        onSnapshotBefore: (payload) => beforeSnapshots.push(payload),
        onSnapshotAfter: (response) => afterSnapshots.push(response),
      },
    );

    expect(result.actualBehavior).toBe('direct');
    expect(processIncomingDirect).toHaveBeenCalledTimes(1);
    expect(processIncomingDirect).toHaveBeenCalledWith(requestPayload);
    expect(processIncoming).not.toHaveBeenCalled();
    expect(beforeSnapshots).toHaveLength(1);
    expect(beforeSnapshots[0]).toBe(requestPayload);
    expect(afterSnapshots).toHaveLength(1);
  });

  it('allows provider-mode direct path to apply lightweight thinking overrides without relay conversion', async () => {
    const { handle, processIncoming, processIncomingDirect } = createHandle('openai-responses');
    const requestPayload = {
      model: 'mimo-v2.5-pro',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      reasoning: { effort: 'low' },
    } as Record<string, unknown>;

    const result = await executeProviderDirectPipeline(
      requestPayload,
      { path: '/v1/responses', headers: {} },
      {
        portConfig: {
          port: 5004,
          host: '127.0.0.1',
          mode: 'provider',
          protocolBehavior: 'auto',
          providerBinding: 'mock.model',
        },
        resolveProvider: () => handle,
        detectInboundProtocol: detectInboundProtocolFromRequest,
        preparePayload: (payload) => {
          payload.reasoning = { effort: 'high' };
        },
      },
    );

    expect(result.actualBehavior).toBe('direct');
    expect(processIncoming).not.toHaveBeenCalled();
    const sentPayload = processIncomingDirect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentPayload.input).toEqual(requestPayload.input);
    expect(sentPayload.reasoning).toEqual({ effort: 'high' });
    expect((sentPayload as { messages?: unknown }).messages).toBeUndefined();
  });
});
