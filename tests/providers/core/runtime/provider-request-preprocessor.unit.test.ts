import { describe, expect, it } from '@jest/globals';

import { ProviderRequestPreprocessor } from '../../../../src/providers/core/runtime/provider-request-preprocessor.js';

describe('provider-request-preprocessor', () => {
  it('keeps assistant content untouched (no provider-layer semantic text rewrite)', () => {
    const req = {
      model: 'provider-a.model-a',
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
        model: 'provider-a.model-a',
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

  it('removes provider-bound metadata fields and only mirrors transport hints into runtime symbol', async () => {
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');
    const runtimeMetadata = { metadata: { clientHeaders: { authorization: 'Bearer x' } } } as any;
    const req = {
      model: 'provider-model',
      metadata: {
        entryEndpoint: '/api/v1/indices/plugin/web_search',
        stream: true,
        providerWebSearch: true,
        clientHeaders: { authorization: 'Bearer x' },
      },
      client_metadata: { session_id: 'client-session' },
      data: { uq: 'routecodex', page: 1, rows: 5 }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req, runtimeMetadata);
    const attached = extractProviderRuntimeMetadata(out as Record<string, unknown>);

    expect(attached?.metadata?.entryEndpoint).toBe('/api/v1/indices/plugin/web_search');
    expect(attached?.metadata?.stream).toBe(true);
    expect(attached?.qwenWebSearch).toBeUndefined();
    expect(attached?.metadata?.qwenWebSearch).toBeUndefined();
    expect((out as any).metadata).toBeUndefined();
    expect((out as any).client_metadata).toBeUndefined();
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
    expect((out as any).metadata).toBeUndefined();
  });

  it('does not move request metadata session fields into runtime metadata or provider-bound body', async () => {
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

    expect(attached?.metadata?.sessionId).toBeUndefined();
    expect(attached?.metadata?.conversationId).toBeUndefined();
    expect(attached?.metadata?.client_tmux_session_id).toBeUndefined();
    expect((attached as any)?.sessionId).toBeUndefined();
    expect((attached as any)?.conversationId).toBeUndefined();
    expect((out as any).metadata).toBeUndefined();
  });

  it('does not bind payload metadata center into runtime metadata during preprocessing', async () => {
    const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');
    const { extractProviderRuntimeMetadata } = await import('../../../../src/providers/core/runtime/provider-runtime-metadata.js');
    const req = {
      model: 'gpt-5.5',
      metadata: {
        entryEndpoint: '/v1/responses'
      }
    } as any;
    const center = MetadataCenter.attach(req.metadata);
    center.writeRequestTruth(
      'portScope',
      '5520',
      {
        module: 'tests/providers/core/runtime/provider-request-preprocessor.unit.test.ts',
        symbol: 'preserves metadata center binding so request truth port scope survives preprocessing',
        stage: 'ServerReqInbound01ClientRaw'
      }
    );
    const runtimeMetadata = { metadata: {} } as any;

    const out = ProviderRequestPreprocessor.preprocess(req, runtimeMetadata);
    const attached = extractProviderRuntimeMetadata(out as Record<string, unknown>);

    expect(attached?.metadata?.entryEndpoint).toBe('/v1/responses');
    expect(MetadataCenter.read(attached?.metadata as Record<string, unknown>)?.readRequestTruth().portScope).toBeUndefined();
    expect((out as any).metadata).toBeUndefined();
  });

  it('recursively removes metadata fields before protocol clients build provider wire bodies', () => {
    const req = {
      model: 'gpt-5.5',
      data: {
        model: 'gpt-5.5',
        metadata: { nestedTop: true },
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'hi',
                metadata: { nested: true },
                client_metadata: { nestedClient: true }
              }
            ]
          }
        ]
      },
      metadata: { top: true },
      client_metadata: { clientTop: true }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req);

    expect((out as any).metadata).toBeUndefined();
    expect((out as any).client_metadata).toBeUndefined();
    expect((out as any).data.metadata).toBeUndefined();
    expect((out as any).data.input[0].content[0].metadata).toBeUndefined();
    expect((out as any).data.input[0].content[0].client_metadata).toBeUndefined();
    expect((out as any).data.input[0].content[0].text).toBe('hi');
  });
});
