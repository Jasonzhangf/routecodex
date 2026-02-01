import { applyRequestCompat, applyResponseCompat } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js';
import { createHash } from 'node:crypto';
import {
  cacheAntigravitySessionSignature,
  extractAntigravityGeminiSessionId,
  getAntigravityRequestSessionMeta,
  lookupAntigravitySessionSignatureEntry,
  resetAntigravitySessionSignatureCachesForTests
} from '../../sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.js';

function stableSid(raw: string): string {
  return `sid-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

describe('antigravity thoughtSignature (gemini-chat)', () => {
  it('uses Antigravity-Manager sessionId derivation (ignores adapterContext.sessionId)', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const baseAdapterContext = {
      providerProtocol: 'gemini-chat',
      runtimeKey: 'antigravity.key1',
      entryEndpoint: '/v1/responses',
      routeId: 'longcontext',
      // This should NOT affect Antigravity session fingerprinting.
      sessionId: 'external-session-id'
    } as any;

    const requestId = 'openai-responses-antigravity.key1.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-901';
    const seedText = 'session seed: antigravity session derivation should ignore external session id';
    const baseRequest = {
      model: 'gemini-3-pro-high',
      project: 'test-project',
      requestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: seedText }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ]
      }
    } as any;

    applyRequestCompat('chat:gemini', baseRequest, {
      adapterContext: { ...baseAdapterContext, requestId }
    });

    const derived = extractAntigravityGeminiSessionId(baseRequest);
    const meta = getAntigravityRequestSessionMeta(requestId);
    expect(meta?.sessionId).toBe(derived);
  });

  it('derives stable sessionId from short first-user text (no JSON fallback)', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const requestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-999';
    const seedText = 'hi';
    const baseRequest = {
      model: 'gemini-3-pro-high',
      project: 'test-project',
      requestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: seedText }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ]
      }
    } as any;

    const derived = extractAntigravityGeminiSessionId(baseRequest);
    expect(derived).toBe(stableSid(seedText));
  });

  it('captures thoughtSignature from any response part (not only functionCall) and injects into subsequent tool calls', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const baseAdapterContext = {
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity.test',
      entryEndpoint: '/v1/responses',
      routeId: 'longcontext'
    } as any;

    const firstRequestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-801';
    const followupRequestId = 'openai-responses-antigravity.test.gemini-3-pro-high-gemini-3-pro-high-20260130T000000000-802';

    const baseRequest = {
      model: 'gemini-3-pro-high',
      project: 'test-project',
      requestId: firstRequestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'session seed: antigravity-thoughtSignature-non-function-call' }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ],
        tools: [{ functionDeclarations: [{ name: 'exec_command', parameters: { type: 'object' } }] }]
      }
    } as any;

    applyRequestCompat('chat:gemini', baseRequest, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });

    const responsePayload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: `EiYK${'c'.repeat(80)}`,
                thought: true,
                text: 'thinking...'
              }
            ]
          }
        }
      ],
      request_id: firstRequestId
    } as any;

    applyResponseCompat('chat:gemini', responsePayload, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });

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

  it('reuses thoughtSignature across different antigravity aliases for the same derived sessionId (global store v2)', () => {
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
                thoughtSignature: `EiYK${'a'.repeat(80)}`,
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
    expect(typeof tailParts[0]?.thoughtSignature).toBe('string');
    expect((tailParts[0]?.thoughtSignature || '').length).toBeGreaterThan(10);
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

  it('does not reuse signatures across different sessions (lookup misses)', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const aliasKey = 'antigravity.rebindTest';
    const session1 = stableSid('session-1');
    const session2 = stableSid('session-2');
    cacheAntigravitySessionSignature(aliasKey, session1, `EiYK${'b'.repeat(80)}`, 3);

    const first = lookupAntigravitySessionSignatureEntry(aliasKey, session2, { hydrate: false });
    expect(first.source).toBe('miss');
    expect(first.signature).toBeUndefined();

    const second = lookupAntigravitySessionSignatureEntry(aliasKey, session2, { hydrate: false });
    expect(second.source).toBe('miss');
    expect(second.signature).toBeUndefined();
  });

  it('applies thoughtSignature cache+inject on chat:gemini-cli profile (gemini-cli.* providers)', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const baseAdapterContext = {
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli.test',
      runtimeKey: 'gemini-cli.test',
      entryEndpoint: '/v1/responses',
      routeId: 'longcontext'
    } as any;

    const firstRequestId = 'openai-responses-gemini-cli.test.gemini-2.5-pro-gemini-2.5-pro-20260130T000000000-901';
    const followupRequestId = 'openai-responses-gemini-cli.test.gemini-2.5-pro-gemini-2.5-pro-20260130T000000000-902';

    const baseRequest = {
      model: 'gemini-2.5-pro',
      project: 'test-project',
      requestId: firstRequestId,
      requestType: 'agent',
      userAgent: 'antigravity',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'session seed: gemini-cli thoughtSignature compat' }] },
          { role: 'model', parts: [{ text: 'ok' }] }
        ],
        tools: [{ functionDeclarations: [{ name: 'exec_command', parameters: { type: 'object' } }] }]
      }
    } as any;

    const first = applyRequestCompat('chat:gemini-cli', baseRequest, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });
    expect(first.appliedProfile).toBe('chat:gemini-cli');

    const responsePayload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: `EiYK${'d'.repeat(80)}`,
                functionCall: { name: 'exec_command', args: { command: 'echo hi' } }
              }
            ]
          }
        }
      ],
      request_id: firstRequestId
    } as any;

    const cached = applyResponseCompat('chat:gemini-cli', responsePayload, {
      adapterContext: { ...baseAdapterContext, requestId: firstRequestId }
    });
    expect(cached.appliedProfile).toBe('chat:gemini-cli');

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

    const second = applyRequestCompat('chat:gemini-cli', followupRequest, {
      adapterContext: { ...baseAdapterContext, requestId: followupRequestId }
    });
    expect(second.appliedProfile).toBe('chat:gemini-cli');

    const tailParts = (second.payload as any)?.request?.contents?.slice(-1)?.[0]?.parts ?? [];
    expect(tailParts[0]?.functionCall?.name).toBe('exec_command');
    expect(typeof tailParts[0]?.thoughtSignature).toBe('string');
    expect((tailParts[0]?.thoughtSignature || '').length).toBeGreaterThan(10);
  });
});
