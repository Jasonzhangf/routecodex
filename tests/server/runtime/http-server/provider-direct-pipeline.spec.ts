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
    },
  };
  return { handle, processIncoming };
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
    const { handle } = createHandle('anthropic-messages');
    await expect(
      executeProviderDirectPipeline(
        {
          model: 'mimo-v2.5-pro',
          input: 'hello',
        },
        { path: '/v1/responses', headers: {} },
        {
          portConfig: {
            port: 5002,
            host: '127.0.0.1',
            mode: 'provider',
            protocolBehavior: 'auto',
            providerBinding: 'mock.model',
          },
          resolveProvider: () => handle,
          detectInboundProtocol: detectInboundProtocolFromRequest,
        },
      ),
    ).rejects.toThrow(/relay only supports openai-chat <-> anthropic-messages today/i);
  });
});
