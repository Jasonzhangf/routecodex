import { applyRequestCompat, applyResponseCompat } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js';

describe('antigravity thoughtSignature (gemini-chat)', () => {
  it('caches thoughtSignature from response and injects into subsequent tool calls', () => {
    const baseAdapterContext = {
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity.test',
      entryEndpoint: '/v1/responses',
      routeId: 'longcontext'
    } as any;

    const firstRequestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-001';
    const followupRequestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-002';

    const baseRequest = {
      model: 'gemini-3-pro-high',
      project: 'test-project',
      requestId: firstRequestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'session seed: antigravity-thoughtSignature-test' }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ],
        tools: [{ functionDeclarations: [{ name: 'exec_command', parameters: { type: 'object' } }] }]
      }
    } as any;

    const first = applyRequestCompat('chat:gemini', baseRequest, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });

    expect(first.appliedProfile).toBe('chat:gemini');
    const firstParts = ((first.payload as any)?.request?.contents ?? []).flatMap((entry: any) => entry?.parts ?? []);
    expect(firstParts.some((part: any) => typeof part?.thoughtSignature === 'string' && part.thoughtSignature.length)).toBe(false);

    const responsePayload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: 'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==',
                functionCall: { name: 'exec_command', args: { command: 'echo hi' } }
              }
            ]
          }
        }
      ],
      request_id: firstRequestId
    } as any;

    const cached = applyResponseCompat('chat:gemini', responsePayload, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });
    expect(cached.appliedProfile).toBe('chat:gemini');

    const followupRequest = {
      ...baseRequest,
      requestId: followupRequestId,
      request: {
        ...baseRequest.request,
        contents: [
          ...baseRequest.request.contents,
          { role: 'model', parts: [{ functionCall: { id: 'fc_0', name: 'exec_command', args: { command: 'pwd' } } }] }
        ]
      }
    } as any;

    const second = applyRequestCompat('chat:gemini', followupRequest, {
      adapterContext: { ...baseAdapterContext, requestId: followupRequestId }
    });

    const tailParts = (second.payload as any)?.request?.contents?.slice(-1)?.[0]?.parts ?? [];
    expect(tailParts[0]?.functionCall?.name).toBe('exec_command');
    expect(typeof tailParts[0]?.thoughtSignature).toBe('string');
    expect((tailParts[0]?.thoughtSignature || '').length).toBeGreaterThan(10);
  });

  it('does not reuse thoughtSignature across different antigravity aliases (same session)', () => {
    const baseAdapterContextA = {
      providerProtocol: 'gemini-chat',
      runtimeKey: 'antigravity.aliasA',
      entryEndpoint: '/v1/responses',
      routeId: 'longcontext'
    } as any;
    const baseAdapterContextB = {
      providerProtocol: 'gemini-chat',
      runtimeKey: 'antigravity.aliasB',
      entryEndpoint: '/v1/responses',
      routeId: 'longcontext'
    } as any;

    const firstRequestId = 'openai-responses-antigravity.aliasA.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-201';
    const followupRequestId = 'openai-responses-antigravity.aliasB.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-202';

    const baseRequest = {
      model: 'gemini-3-pro-high',
      project: 'test-project',
      requestId: firstRequestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'session seed: alias isolation test' }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ],
        tools: [{ functionDeclarations: [{ name: 'exec_command', parameters: { type: 'object' } }] }]
      }
    } as any;

    applyRequestCompat('chat:gemini', baseRequest, {
      adapterContext: { ...baseAdapterContextA, requestId: firstRequestId }
    });

    const responsePayload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: 'EiYKJGFsaWFzQS1zaWduYXR1cmU=',
                functionCall: { name: 'exec_command', args: { command: 'echo hi' } }
              }
            ]
          }
        }
      ],
      request_id: firstRequestId
    } as any;

    applyResponseCompat('chat:gemini', responsePayload, {
      adapterContext: { ...baseAdapterContextA, requestId: firstRequestId }
    });

    const followupRequest = {
      ...baseRequest,
      requestId: followupRequestId,
      request: {
        ...baseRequest.request,
        contents: [
          ...baseRequest.request.contents,
          { role: 'model', parts: [{ functionCall: { id: 'fc_1', name: 'exec_command', args: { command: 'pwd' } } }] }
        ]
      }
    } as any;

    const second = applyRequestCompat('chat:gemini', followupRequest, {
      adapterContext: { ...baseAdapterContextB, requestId: followupRequestId }
    });

    const tailParts = (second.payload as any)?.request?.contents?.slice(-1)?.[0]?.parts ?? [];
    expect(tailParts[0]?.functionCall?.name).toBe('exec_command');
    expect(typeof tailParts[0]?.thoughtSignature).not.toBe('string');
  });

  it('injects into servertool-like web_search functionCall parts (web_search route)', () => {
    const baseAdapterContext = {
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity.test',
      entryEndpoint: '/v1/responses',
      routeId: 'web_search'
    } as any;

    const firstRequestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-101';
    const followupRequestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-102';

    const baseRequest = {
      model: 'gemini-3-pro-high',
      project: 'test-project',
      requestId: firstRequestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'seed: web_search thoughtSignature injection' }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ],
        tools: [{ functionDeclarations: [{ name: 'web_search', parameters: { type: 'object' } }] }]
      }
    } as any;

    const first = applyRequestCompat('chat:gemini', baseRequest, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });
    expect(first.appliedProfile).toBe('chat:gemini');

    const responsePayload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: 'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw==',
                functionCall: { name: 'web_search', args: { query: 'hello', recency: '7d', count: 5 } }
              }
            ]
          }
        }
      ],
      request_id: firstRequestId
    } as any;

    const cached = applyResponseCompat('chat:gemini', responsePayload, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });
    expect(cached.appliedProfile).toBe('chat:gemini');

    const followupRequest = {
      ...baseRequest,
      requestId: followupRequestId,
      request: {
        ...baseRequest.request,
        contents: [
          ...baseRequest.request.contents,
          { role: 'model', parts: [{ functionCall: { id: 'fc_web_0', name: 'web_search', args: { query: 'x' } } }] }
        ]
      }
    } as any;

    const second = applyRequestCompat('chat:gemini', followupRequest, {
      adapterContext: { ...baseAdapterContext, requestId: followupRequestId }
    });

    const tailParts = (second.payload as any)?.request?.contents?.slice(-1)?.[0]?.parts ?? [];
    expect(tailParts[0]?.functionCall?.name).toBe('web_search');
    expect(typeof tailParts[0]?.thoughtSignature).toBe('string');
    expect((tailParts[0]?.thoughtSignature || '').length).toBeGreaterThan(10);
  });
});
