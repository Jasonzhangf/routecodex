import { describe, expect, it } from '@jest/globals';

import {
  buildDirectProviderRuntimeMetadata,
  buildRouterDirectRouteMetadata,
} from '../../../../src/server/runtime/http-server/direct-runtime-metadata.js';

describe('direct-runtime-metadata', () => {
  it('projects only provider runtime primitive controls from cyclic live metadata', () => {
    const metadata: Record<string, unknown> = {
      entryEndpoint: '/v1/responses',
      clientRequestId: 'client-1',
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      entryPort: 5520,
      providerStreamNoContentTimeoutMs: 120_000,
      metadataCenterSnapshot: {
        runtimeControl: {
          stopMessageEnabled: true,
        },
      },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    };
    metadata.self = metadata;

    const projected = buildDirectProviderRuntimeMetadata({
      metadata,
      entryEndpoint: '/v1/responses',
      localPort: 5520,
      providerProtocol: 'openai-responses',
    });

    expect(projected).toEqual({
      entryEndpoint: '/v1/responses',
      entryPort: 5520,
      matchedPort: 5520,
      routecodexLocalPort: 5520,
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      clientRequestId: 'client-1',
      providerStreamNoContentTimeoutMs: 120_000,
      __responsesDirectPassthrough: true,
    });
    expect(JSON.stringify(projected)).toContain('__responsesDirectPassthrough');
    expect(projected).not.toHaveProperty('metadataCenterSnapshot');
    expect(projected).not.toHaveProperty('input');
    expect(projected).not.toHaveProperty('self');
  });

  it('projects only route-safe metadata before virtual router JSON serialization', () => {
    const requestBody = {
      model: 'gpt-5.5',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    };
    const metadata: Record<string, unknown> = {
      requestId: 'req-route-image',
      clientRequestId: 'client-route-image',
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      entryPort: 5520,
      allowedProviders: ['cc.key1.gpt-5.5'],
      __raw_request_body: requestBody,
      entryOriginRequest: requestBody,
      requestSemantics: { input: requestBody.input },
      metadataCenterSnapshot: {
        requestTruth: { requestId: 'req-route-image' },
        runtimeControl: { routecodexRoutingPolicyGroup: 'gateway_priority_5520' },
      },
    };
    metadata.self = metadata;

    const projected = buildRouterDirectRouteMetadata({
      metadata,
      metadataCenterSnapshot: metadata.metadataCenterSnapshot as Record<string, unknown>,
      requestId: 'req-route-image',
      entryEndpoint: '/v1/responses',
    });

    expect(projected).toMatchObject({
      requestId: 'req-route-image',
      clientRequestId: 'client-route-image',
      entryEndpoint: '/v1/responses',
      routecodexRoutingPolicyGroup: 'gateway_priority_5520',
      entryPort: 5520,
      allowedProviders: ['cc.key1.gpt-5.5'],
      metadataCenterSnapshot: {
        requestId: 'req-route-image',
        requestTruth: { requestId: 'req-route-image' },
        runtimeControl: { routecodexRoutingPolicyGroup: 'gateway_priority_5520' },
        allowedProviders: ['cc.key1.gpt-5.5'],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('data:image/png;base64,AAAA');
    expect(projected).not.toHaveProperty('__raw_request_body');
    expect(projected).not.toHaveProperty('entryOriginRequest');
    expect(projected).not.toHaveProperty('requestSemantics');
    expect(projected).not.toHaveProperty('self');
  });

  it('preserves route log session color keys for virtual-router-hit formatting', () => {
    const projected = buildRouterDirectRouteMetadata({
      metadata: {
        requestId: 'req-route-color',
        clientRequestId: 'client-route-color',
        routecodexRoutingPolicyGroup: 'gateway_priority_5520',
        logSessionColorKey: 'codex-session-color',
        clientTmuxSessionId: 'tmux-session-color',
        tmuxSessionId: 'tmux-fallback-color',
        rccSessionClientTmuxSessionId: 'rcc-tmux-color',
      },
      metadataCenterSnapshot: {
        requestTruth: {
          requestId: 'req-route-color',
          sessionId: 'request-truth-session',
          conversationId: 'conversation-color',
        },
      },
      requestId: 'req-route-color',
      entryEndpoint: '/v1/responses',
    });

    expect(projected).toMatchObject({
      requestId: 'req-route-color',
      clientRequestId: 'client-route-color',
      logSessionColorKey: 'codex-session-color',
      clientTmuxSessionId: 'tmux-session-color',
      tmuxSessionId: 'tmux-fallback-color',
      rccSessionClientTmuxSessionId: 'rcc-tmux-color',
      metadataCenterSnapshot: {
        requestId: 'req-route-color',
        sessionId: 'request-truth-session',
        conversationId: 'conversation-color',
        logSessionColorKey: 'codex-session-color',
        clientTmuxSessionId: 'tmux-session-color',
        tmuxSessionId: 'tmux-fallback-color',
        rccSessionClientTmuxSessionId: 'rcc-tmux-color',
      },
    });
  });
});
