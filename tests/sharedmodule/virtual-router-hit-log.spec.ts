import { jest } from '@jest/globals';

import {
  createVirtualRouterHitRecord,
  formatVirtualRouterHit,
  resolveSessionColor,
  resolveSessionLogColorKey,
  toVirtualRouterHitEvent
} from './helpers/virtual-router-hit-log-direct-native.js';
import {
  createVirtualRouterRouteHostEffects
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

describe('virtual-router hit log', () => {
  it('includes request token estimate when available', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input',
      sessionId: 'session-hit-token-estimate',
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
      sessionId: 'session-hit-token-missing',
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
      sessionId: 'session-hit-penalty',
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

  it('accepts nested routing state without TS flattening stopMessage fields', () => {
    const line = formatVirtualRouterHit(createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      sessionId: 'session-hit-routing-state',
      routingState: {
        stopMessageText: 'continue until done',
        stopMessageMaxRepeats: 3,
        stopMessageUsed: 1,
        stopMessageStageMode: 'auto'
      }
    }));

    expect(line).toContain('[stopMessage:"continue until done" mode=auto round=1/3 active=yes left=2]');
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

  it('does not reuse the same visible color for adjacent active sessions', () => {
    const first = resolveSessionColor('active-session-color-2');
    const second = resolveSessionColor('active-session-color-3');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('rejects virtual-router-hit formatting when no session id is present', () => {
    const record = createVirtualRouterHitRecord({
      routeName: 'thinking',
      poolId: 'thinking-primary',
      providerKey: 'glm.key1.kimi-k2.5',
      modelId: 'kimi-k2.5',
      hitReason: 'thinking:user-input'
    });

    expect(resolveSessionColor()).toBeUndefined();
    expect(() => formatVirtualRouterHit(record)).toThrow(/sessionId is required/);
  });

  it('emits host virtual-router-hit lines with request session color instead of route color', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = 'host-visible-session-color';
    const sessionColor = resolveSessionColor(sessionId);
    const routeColor = resolveSessionColor('thinking');
    const effects = createVirtualRouterRouteHostEffects({
      request: {},
      metadata: {
        requestId: 'req-host-hit-color',
        sessionId,
        logSessionColorKey: 'route-color-must-not-win'
      }
    });

    effects.finalize({
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        modelId: 'gpt-5.5'
      },
      decision: {
        providerKey: 'cc.key1.gpt-5.5',
        routeName: 'thinking',
        poolId: 'gateway-priority-5520-priority-thinking',
        reasoning: 'thinking:user-input'
      }
    }, () => null);

    const line = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(sessionColor).toBeDefined();
    expect(routeColor).toBeDefined();
    expect(line.startsWith(String(sessionColor))).toBe(true);
    expect(line.startsWith(String(routeColor))).toBe(false);
    expect(line).toContain('req=req-host-hit-color');
    expect(line).toContain(`sid=${sessionId}`);
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
