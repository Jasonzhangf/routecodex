import { describe, expect, it, jest } from '@jest/globals';

describe('servertool adapter context builder', () => {
  it('builds shared adapter context from entry origin request and metadata', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const entryOriginRequest = {
      model: 'client-model',
      messages: [{ role: 'user', content: '继续' }]
    };
    const metadata: Record<string, unknown> = {
      routeName: 'thinking-primary',
      sessionId: 'sess-1',
      clientTmuxSessionId: 'tmux-1',
      __rt: {
        existing: true
      }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeProviderObservation(
      'assignedModelId',
      'kimi-k2.5',
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'builds shared adapter context from entry origin request and metadata',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'compatibilityProfile',
      'anthropic-claude',
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'builds shared adapter context from entry origin request and metadata',
        stage: 'test'
      }
    );

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest,
      requestSemantics: {
        tools: {
          clientToolsRaw: [{ type: 'function', function: { name: 'exec_command' } }]
        }
      },
      requestId: 'req-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      serverToolsEnabled: false
    });

    expect(context.requestId).toBe('req-1');
    expect(context.entryEndpoint).toBe('/v1/responses');
    expect(context.providerProtocol).toBe('openai-responses');
    expect(context.routeId).toBe('thinking-primary');
    expect(context.originalModelId).toBe('client-model');
    expect(context.modelId).toBe('kimi-k2.5');
    expect(context.compatibilityProfile).toBe('anthropic-claude');
    expect(context.serverToolsEnabled).toBe(false);
    expect(context.serverToolsDisabled).toBe(true);
    expect(context.__rt).toEqual({ existing: true });
    expect(context.__rt as Record<string, unknown>).not.toHaveProperty('stopMessageClientInjectReady');
    expect(context.__rt as Record<string, unknown>).not.toHaveProperty('stopMessageClientInjectTmuxSessionId');
    expect(MetadataCenter.read(context)?.readRuntimeControl().stopMessageClientInject).toMatchObject({
      ready: true,
      tmuxSessionId: 'tmux-1'
    });
    expect(context.capturedEntryRequest).toBe(entryOriginRequest);
    expect(context.capturedChatRequest).toBe(entryOriginRequest);
  });

  it('preserves canonical stopless runtime control and drops legacy stopmessage mirrors', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'stopless',
      {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        triggerHint: 'no_schema',
        active: true
      },
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'preserves canonical stopless runtime control and drops legacy stopmessage mirrors',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'serverToolLoopState',
      {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        triggerHint: 'no_schema'
      },
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'preserves canonical stopless runtime control and drops legacy stopmessage mirrors',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'stopMessageState',
      {
        stopMessageText: '请补齐 stop schema 后继续。',
        stopMessageMaxRepeats: 3,
        stopMessageUsed: 1,
        stopMessageStageMode: 'on'
      },
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'preserves canonical stopless runtime control and drops legacy stopmessage mirrors',
        stage: 'test'
      }
    );

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest: { model: 'gpt-5.5', input: '继续' },
      requestSemantics: {},
      requestId: 'req-stopless-runtime-control',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      serverToolsEnabled: true
    });

    const runtime = MetadataCenter.read(context)?.readRuntimeControl();
    expect(runtime?.stopless).toMatchObject({
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3,
      triggerHint: 'no_schema',
      active: true
    });
    expect(runtime?.serverToolLoopState).toBeUndefined();
    expect(runtime?.stopMessageState).toBeUndefined();
  });

  it('maps routeHint into routeId for stop followup planning', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        routeHint: 'search',
        routecodexPortMode: 'router'
      },
      entryOriginRequest: { model: 'gpt-5.5', input: 'continue' },
      requestSemantics: {},
      requestId: 'req-route-hint',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      serverToolsEnabled: true
    });

    expect(context.routeId).toBe('search');
  });

  it('does not infer clientProtocol from entry endpoint when metadata center did not write one', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {},
      entryOriginRequest: { model: 'gpt-5.4', input: 'continue' },
      requestId: 'req-no-client-protocol-infer',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat'
    });

    expect(context.clientProtocol).toBeUndefined();
  });

  it('backfills session and conversation identifiers from entry origin request metadata', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {},
      entryOriginRequest: {
        metadata: {
          sessionId: 'sess-origin',
          conversationId: 'conv-origin'
        },
        input: 'continue'
      },
      requestId: 'req-session-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

  it('reads request session and conversation identifiers only from metadata center request truth', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'sessionId',
      'sess-center-truth',
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'reads request session and conversation identifiers only from metadata center request truth',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'conv-center-truth',
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'reads request session and conversation identifiers only from metadata center request truth',
        stage: 'test'
      }
    );

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest: {
        metadata: {
          sessionId: 'sess-origin-should-not-win',
          conversationId: 'conv-origin-should-not-win'
        },
        input: 'continue'
      },
      requestId: 'req-session-center-truth',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBe('sess-center-truth');
    expect(context.conversationId).toBe('conv-center-truth');
    expect(MetadataCenter.read(context)).toBe(center);
  });

  it('preserves the bound MetadataCenter on the servertool adapter context', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'stopMessageEnabled',
      true,
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'preserves the bound MetadataCenter on the servertool adapter context',
        stage: 'test'
      }
    );

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest: {
        input: 'continue'
      },
      requestId: 'req-preserve-center',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(MetadataCenter.read(context)).toBe(center);
    expect(MetadataCenter.read(context)?.readRuntimeControl().stopMessageEnabled).toBe(true);
  });

  it('does not project providerFamily into MetadataCenter runtime_control', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const metadata: Record<string, unknown> = {
      providerFamily: 'anthropic'
    };

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest: {
        input: 'continue'
      },
      requestId: 'req-no-provider-family-runtime-control',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(MetadataCenter.read(context)?.readRuntimeControl()).not.toHaveProperty('providerFamily');
  });

  it('binds a fresh MetadataCenter onto the adapter context when input metadata has no bound center', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const metadata: Record<string, unknown> = {
      routeName: 'thinking'
    };

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest: {
        input: 'continue'
      },
      requestId: 'req-bind-fresh-center',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(MetadataCenter.read(metadata)).toBeUndefined();
    expect(MetadataCenter.read(context)).toBeDefined();
  });

  it('reads assigned model and compatibility profile from MetadataCenter provider observation when flat metadata is absent', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );
    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeProviderObservation(
      'assignedModelId',
      'MiniMax-M2.7',
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'reads assigned model and compatibility profile from MetadataCenter provider observation when flat metadata is absent',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'compatibilityProfile',
      'anthropic-claude',
      {
        module: 'tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts',
        symbol: 'reads assigned model and compatibility profile from MetadataCenter provider observation when flat metadata is absent',
        stage: 'test'
      }
    );

    const context = buildServerToolAdapterContext({
      metadata,
      entryOriginRequest: {
        model: 'client-model'
      },
      requestId: 'req-provider-observation-center',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.modelId).toBe('MiniMax-M2.7');
    expect(context.compatibilityProfile).toBe('anthropic-claude');
  });

  it('does not synthesize request session and conversation identifiers from relay responsesRequestContext metadata', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        responsesRequestContext: {
          sessionId: 'sess-relay',
          conversationId: 'conv-relay'
        }
      },
      requestId: 'req-session-relay-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

  it('does not synthesize request truth from relay requestSessionId aliases inside responsesRequestContext', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        responsesRequestContext: {
          requestSessionId: 'sess-relay-request-alias',
          requestConversationId: 'conv-relay-request-alias'
        }
      },
      requestId: 'req-session-relay-request-alias',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

  it('does not synthesize request session and conversation identifiers from nested __rt.responsesRequestContext metadata', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        __rt: {
          responsesRequestContext: {
            sessionId: 'sess-relay-rt',
            conversationId: 'conv-relay-rt'
          }
        }
      },
      requestId: 'req-session-relay-rt-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

  it('does not treat top-level responsesRequestContext session fields as request truth when metadata bag is already flattened', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        responsesRequestContext: {
          sessionId: 'sess-relay-flat',
          conversationId: 'conv-relay-flat'
        },
        sessionId: 'sess-relay-flat',
        conversationId: 'conv-relay-flat'
      },
      requestId: 'req-session-relay-flat-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

  it('does not backfill request session and conversation identifiers from metadata.sessionId without entry origin request', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        sessionId: 'sess-meta-direct',
        conversationId: 'conv-meta-direct'
      },
      requestId: 'req-session-meta-direct-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

  it('does not backfill request session and conversation identifiers from __rt.sessionId without entry origin request', async () => {
    jest.resetModules();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        __rt: {
          sessionId: 'sess-rt-direct',
          conversationId: 'conv-rt-direct'
        }
      },
      requestId: 'req-session-rt-direct-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.conversationId).toBeUndefined();
  });

});
