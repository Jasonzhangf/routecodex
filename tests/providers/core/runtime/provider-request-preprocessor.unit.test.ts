import { describe, expect, it } from '@jest/globals';

import { ProviderRequestPreprocessor } from '../../../../src/providers/core/runtime/provider-request-preprocessor.js';

describe('provider-request-preprocessor', () => {
  it('keeps assistant content untouched (no provider-layer semantic text rewrite)', () => {
    const req = {
      model: 'qwenchat.qwen3.6-plus',
      messages: [
        { role: 'system', content: 'you are assistant' },
        {
          role: 'assistant',
          content: 'Tool exec_command does not exists.Tool write_stdin does not exists.Jason, 我先分析。'
        },
        { role: 'user', content: '继续' }
      ]
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req);
    const assistant = out.messages?.[1];
    expect(assistant?.content).toContain('Jason, 我先分析。');
    expect(String(assistant?.content || '')).toContain('Tool exec_command does not exists');
    expect(String(assistant?.content || '')).toContain('Tool write_stdin does not exists');
  });

  it('keeps responses-style input assistant text untouched', () => {
    const req = {
      data: {
        model: 'qwenchat.qwen3.6-plus',
        input: [
          {
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Tool exec_command does not exists. Tool update_plan does not exists.继续执行'
              }
            ]
          }
        ]
      }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req);
    const text = out?.data?.input?.[0]?.content?.[0]?.text;
    expect(String(text || '')).toContain('继续执行');
    expect(String(text || '')).toContain('Tool exec_command does not exists');
    expect(String(text || '')).toContain('Tool update_plan does not exists');
  });

  it('RED: should move provider runtime hints into runtime symbol instead of keeping control metadata in outbound body', async () => {
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');
    const runtimeMetadata = { metadata: { clientHeaders: { authorization: 'Bearer x' } } } as any;
    const req = {
      model: 'qwen3.5-plus',
      metadata: {
        entryEndpoint: '/api/v1/indices/plugin/web_search',
        stream: true,
        qwenWebSearch: true,
        clientHeaders: { authorization: 'Bearer x' },
      },
      data: { uq: 'routecodex', page: 1, rows: 5 }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req, runtimeMetadata);
    const attached = extractProviderRuntimeMetadata(out as Record<string, unknown>);

    expect(attached?.metadata?.entryEndpoint).toBe('/api/v1/indices/plugin/web_search');
    expect(attached?.metadata?.stream).toBe(true);
    expect(attached?.qwenWebSearch).toBe(true);
    expect((out as any).metadata?.entryEndpoint).toBeUndefined();
    expect((out as any).metadata?.stream).toBeUndefined();
    expect((out as any).metadata?.clientHeaders).toBeUndefined();
  });

  it('prefers client SSE accept header over stale body metadata stream=false', async () => {
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');
    const runtimeMetadata = {
      metadata: {
        clientHeaders: {
          Accept: 'text/event-stream'
        }
      }
    } as any;
    const req = {
      model: 'gpt-5.5',
      metadata: {
        stream: false
      }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req, runtimeMetadata);
    const attached = extractProviderRuntimeMetadata(out as Record<string, unknown>);

    expect(attached?.metadata?.stream).toBe(true);
    expect((out as any).metadata?.stream).toBeUndefined();
  });

  it('physically removes session and conversation control metadata from outbound body', async () => {
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');
    const runtimeMetadata = { metadata: {} } as any;
    const req = {
      model: 'gpt-5.5',
      metadata: {
        sessionId: 'sess-live',
        conversationId: 'conv-live',
        client_tmux_session_id: 'tmux-live'
      }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req, runtimeMetadata);
    const attached = extractProviderRuntimeMetadata(out as Record<string, unknown>);

    expect(attached?.metadata?.sessionId).toBe('sess-live');
    expect(attached?.metadata?.conversationId).toBe('conv-live');
    expect(attached?.metadata?.client_tmux_session_id).toBe('tmux-live');
    expect((out as any).metadata).toBeUndefined();
  });
});
