import {
  createVirtualRouterHitRecord,
  formatVirtualRouterHit,
  toVirtualRouterHitEvent
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-logging.js';

describe('virtual-router hit log', () => {
  it('includes request token estimate when available', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'iflow.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input',
      requestTokens: 1234.6
    }));

    expect(line).toContain('reqTokens=1235');
  });

  it('omits request token estimate when unavailable', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'iflow.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input'
    }));

    expect(line).not.toContain('reqTokens=');
  });

  it('includes penalty label when selection penalty exists', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'iflow.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input',
      selectionPenalty: 3
    }));

    expect(line).toContain('penalty=3');
  });

  it('maps the same hit record into telemetry payload', () => {
    const record = createVirtualRouterHitRecord({
      routeName: 'tools',
      poolId: 'tools-primary',
      providerKey: 'tabglm.key1.glm-5',
      modelId: 'glm-5',
      hitReason: 'tools:last-tool-other',
      selectionPenalty: 2,
      requestTokens: 777
    });
    const event = toVirtualRouterHitEvent(record, {
      requestId: 'req-hit-1',
      entryEndpoint: '/v1/messages'
    });

    expect(event.routeName).toBe('tools');
    expect(event.pool).toBe('tools-primary');
    expect(event.reason).toBe('tools:last-tool-other');
    expect(event.selectionPenalty).toBe(2);
    expect(event.requestTokens).toBe(777);
  });
});
