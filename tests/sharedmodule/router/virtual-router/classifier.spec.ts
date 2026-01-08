import { RoutingClassifier } from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/classifier.js';
import type { RoutingFeatures, RouterMetadataInput } from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

function buildMetadata(overrides?: Partial<RouterMetadataInput>): RouterMetadataInput {
  return {
    requestId: 'req-test',
    entryEndpoint: '/v1/responses',
    processMode: 'chat',
    stream: true,
    direction: 'request',
    ...(overrides ?? {})
  };
}

function buildFeatures(overrides?: Partial<RoutingFeatures>): RoutingFeatures {
  return {
    requestId: 'req-test',
    model: 'demo',
    totalMessages: 2,
    userTextSample: 'hello',
    toolCount: 0,
    hasTools: false,
    hasToolCallResponses: false,
    hasVisionTool: false,
    hasImageAttachment: false,
    hasWebTool: false,
    hasCodingTool: false,
    hasThinkingKeyword: false,
    estimatedTokens: 500,
    metadata: buildMetadata(),
    ...(overrides ?? {})
  };
}

describe('RoutingClassifier user overrides', () => {
  const classifier = new RoutingClassifier({});

  it('prefers thinking route when user interrupts after a write tool', () => {
    const result = classifier.classify(
      buildFeatures({
        latestMessageFromUser: true,
        lastAssistantToolCategory: 'write'
      })
    );
    expect(result.routeName).toBe('thinking');
    expect(result.reasoning).toContain('thinking:user-input');
  });

  it('keeps coding route when continuation is uninterrupted', () => {
    const result = classifier.classify(
      buildFeatures({
        latestMessageFromUser: false,
        lastAssistantToolCategory: 'write'
      })
    );
    expect(result.routeName).toBe('coding');
    expect(result.reasoning).toContain('coding:last-tool-write');
  });
});
