import {
  createVirtualRouterHitRecord,
  formatVirtualRouterHit,
  resolveRouteColor,
  resolveSessionColor,
  resolveSessionLogColorKey,
  toVirtualRouterHitEvent
} from '../../sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.js';

describe('virtual-router hit log', () => {
  it('includes request token estimate when available', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
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
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input'
    }));

    expect(line).not.toContain('reqTokens=');
  });

  it('omits configured noisy hit-log fields without dropping route/provider truth', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      requestId: 'req-verbose-1',
      sessionId: 'tmux-noisy-1',
      routeName: 'longcontext',
      poolId: 'gateway-priority-5555-priority-longcontext',
      providerKey: 'XLC.key2.deepseek-v4-pro',
      modelId: 'deepseek-v4-pro',
      hitReason: 'longcontext:token-threshold|tools:last-tool-other',
      continuationScope: 'responses:abcdef1234567890',
      requestTokens: 222222,
      selectionPenalty: 9
    }), {
      omit: ['requestId', 'sessionId', 'model', 'reason', 'continuation', 'requestTokens', 'selectionPenalty']
    });

    expect(line).toContain('[virtual-router-hit]');
    expect(line).toContain('longcontext/gateway-priority-5555-priority-longcontext -> XLC[key2]');
    expect(line).not.toContain('req=req-verbose-1');
    expect(line).not.toContain('sid=tmux-noisy-1');
    expect(line).not.toContain('.deepseek-v4-pro');
    expect(line).not.toContain('reason=');
    expect(line).not.toContain('[continuation:');
    expect(line).not.toContain('reqTokens=');
    expect(line).not.toContain('penalty=');
  });

  it('includes penalty label when selection penalty exists', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
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

  it('includes session id in hit log and uses session-derived coloring', () => {
    const lineA = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input',
      sessionId: 'tmux-alpha-01'
    }));
    const lineB = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'tools',
      poolId: 'tools-primary',
      providerKey: 'tabglm.key1.glm-5',
      modelId: 'glm-5',
      hitReason: 'tools:last-tool-other',
      sessionId: 'tmux-alpha-01'
    }));
    const lineC = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input',
      sessionId: 'tmux-zeta-99'
    }));

    expect(lineA).toContain('sid=tmux-alpha-01');
    expect(lineB).toContain('sid=tmux-alpha-01');
    expect(lineC).toContain('sid=tmux-zeta-99');

    const colorPrefixA = lineA.match(/(\x1b\[[0-9;]*m)thinking\/thinking-primary/)?.[1];
    const colorPrefixB = lineB.match(/(\x1b\[[0-9;]*m)tools\/tools-primary/)?.[1];
    const colorPrefixC = lineC.match(/(\x1b\[[0-9;]*m)thinking\/thinking-primary/)?.[1];

    expect(colorPrefixA).toBeTruthy();
    expect(colorPrefixB).toBeTruthy();
    expect(colorPrefixC).toBeTruthy();
    expect(colorPrefixA).toBe(colorPrefixB);
    expect(colorPrefixA).not.toBe(colorPrefixC);
  });

  it('uses one session color for virtual-router-hit prefix and target label', () => {
    const sessionId = '019cdb2b-c9f2-7d51-aa85-a62fd2a8fed0';
    const sessionColor = resolveSessionColor(sessionId);
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input',
      sessionId
    }));

    expect(sessionColor).toBeDefined();
    expect(line).toContain(`${sessionColor}[virtual-router-hit]\x1b[0m`);
    expect(line).toContain(`sid=${sessionId} ${sessionColor}thinking/thinking-primary`);
  });

  it('uses route color only when no session id is present', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input'
    }));

    expect(resolveSessionColor()).toBeUndefined();
    expect(line).toContain(`${resolveRouteColor('thinking')}[virtual-router-hit]\x1b[0m`);
    expect(line).not.toContain(' sid=');
  });

  it('prefers request session id over stable tmux scope for log color key', () => {
    expect(resolveSessionLogColorKey({
      sessionId: 'request-session-a',
      clientTmuxSessionId: 'tmux-session-stable'
    })).toBe('request-session-a');
    expect(resolveSessionLogColorKey({
      sessionId: 'request-session-b',
      tmux_session_id: 'tmux-session-stable'
    })).toBe('request-session-b');
  });
});
