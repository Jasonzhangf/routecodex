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

  it('fails fast when cross-protocol relay reaches provider-direct instead of Hub Pipeline', async () => {
    const { handle, processIncoming } = createHandle('anthropic-messages');
    await expect(
      executeProviderDirectPipeline(
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
      ),
    ).rejects.toThrow(/Provider mode relay must run through Hub Pipeline\/chat process/i);
    expect(processIncoming).not.toHaveBeenCalled();
  });

  it('fails fast when relay would require provider-direct cross-protocol semantic mapping', async () => {
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
    ).rejects.toThrow(/Provider mode relay must run through Hub Pipeline\/chat process/i);
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

  it('passes apply_patch payload through unchanged in provider same-protocol direct mode', async () => {
    const { handle, processIncoming, processIncomingDirect } = createHandle('openai-chat');
    const applyPatchArguments = JSON.stringify({
      patch: '*** Begin Patch\n*** Add File: provider-direct.txt\n+ok\n*** End Patch',
    });
    const requestPayload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'edit a file' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_apply_patch_provider_direct',
              type: 'function',
              function: { name: 'apply_patch', arguments: applyPatchArguments },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'canonical client apply_patch tool',
            parameters: {
              type: 'object',
              properties: { patch: { type: 'string' } },
              required: ['patch'],
              additionalProperties: false,
            },
          },
        },
      ],
    } as Record<string, unknown>;
    const originalSnapshot = structuredClone(requestPayload);

    const result = await executeProviderDirectPipeline(
      requestPayload,
      { path: '/v1/chat/completions', headers: {} },
      {
        portConfig: {
          port: 5005,
          host: '127.0.0.1',
          mode: 'provider',
          protocolBehavior: 'auto',
          providerBinding: 'mock.model',
        },
        resolveProvider: () => handle,
        detectInboundProtocol: detectInboundProtocolFromRequest,
      },
    );

    expect(result.actualBehavior).toBe('direct');
    expect(processIncomingDirect).toHaveBeenCalledTimes(1);
    const sentPayload = processIncomingDirect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentPayload).toBe(requestPayload);
    expect(sentPayload).toEqual(originalSnapshot);
    expect(JSON.stringify(sentPayload)).not.toContain('hashline-first');
    expect(JSON.stringify(sentPayload)).not.toContain('fileContent');
    expect(processIncoming).not.toHaveBeenCalled();
  });

  it('rejects apply_patch relay in provider-direct so chat process remains the only hashline owner', async () => {
    const { handle, processIncoming } = createHandle('anthropic-messages');
    const requestPayload = {
      messages: [{ role: 'user', content: 'edit a file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'canonical client apply_patch tool',
            parameters: {
              type: 'object',
              properties: { patch: { type: 'string', description: 'canonical patch' } },
              required: ['patch'],
              additionalProperties: false,
            },
          },
        },
      ],
    } as Record<string, unknown>;

    await expect(
      executeProviderDirectPipeline(
        requestPayload,
        { path: '/v1/chat/completions', headers: {} },
        {
          portConfig: {
            port: 5006,
            host: '127.0.0.1',
            mode: 'provider',
            protocolBehavior: 'auto',
            providerBinding: 'mock.model',
          },
          resolveProvider: () => handle,
          detectInboundProtocol: detectInboundProtocolFromRequest,
        },
      ),
    ).rejects.toThrow(/Provider mode relay must run through Hub Pipeline\/chat process/i);
    expect(processIncoming).not.toHaveBeenCalled();
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
