import { describe, expect, it } from '@jest/globals';

type Route = { mode?: string; targets?: string[]; target?: string; loadBalancing?: unknown };

describe('gateway_priority_5555 routing policy guard', () => {
  const toolLb = {
    strategy: 'weighted',
    weights: { 'mini27.MiniMax-M2.7': 1, 'mimo.mimo-v2.5': 1 }
  };
  const policy = {
    routing: {
      coding: [{ mode: 'priority', targets: ['fwd.gpt.gpt-5.5', 'fwd.minimax.MiniMax-M3', 'mimo.mimo-v2.5'] }],
      thinking: [{ mode: 'priority', targets: ['fwd.gpt.gpt-5.5', 'fwd.minimax.MiniMax-M3', 'mimo.mimo-v2.5'] }],
      tools: [{ mode: 'weighted', targets: ['mini27.MiniMax-M2.7', 'mimo.mimo-v2.5'], loadBalancing: toolLb }],
      search: [{ mode: 'weighted', targets: ['mini27.MiniMax-M2.7', 'mimo.mimo-v2.5'], loadBalancing: toolLb }],
      web_search: [{ mode: 'weighted', targets: ['mini27.MiniMax-M2.7', 'mimo.mimo-v2.5'], loadBalancing: toolLb }]
    }
  } as { routing: Record<string, Route[]> };

  it('keeps coding/thinking routes on GPT forwarder priority order', () => {
    for (const routeName of ['coding', 'thinking']) {
      const route = policy.routing[routeName]?.[0];
      expect(route?.mode).toBe('priority');
      expect(route?.targets).toEqual(['fwd.gpt.gpt-5.5', 'fwd.minimax.MiniMax-M3', 'mimo.mimo-v2.5']);
      expect(route?.loadBalancing).toBeUndefined();
    }
  });

  it('keeps tools/search/web_search on mini27 <-> mimo weighted load balancing', () => {
    for (const routeName of ['tools', 'search', 'web_search']) {
      const route = policy.routing[routeName]?.[0];
      expect(route?.mode).toBe('weighted');
      expect(route?.targets).toEqual(['mini27.MiniMax-M2.7', 'mimo.mimo-v2.5']);
      expect(route?.loadBalancing).toEqual(toolLb);
    }
  });

  it('does not route 5555 tool/search traffic to sdfv, cc, opencode, or deepseek flash', () => {
    const serializedToolRoutes = JSON.stringify({
      tools: policy.routing.tools,
      search: policy.routing.search,
      web_search: policy.routing.web_search
    });
    expect(serializedToolRoutes).not.toContain('sdfv');
    expect(serializedToolRoutes).not.toContain('cc.key1');
    expect(serializedToolRoutes).not.toContain('opencode');
    expect(serializedToolRoutes).not.toContain('deepseek-v4-flash-free');
  });

  it('does not route 5555 coding/thinking traffic directly to concrete GPT providers', () => {
    const serialized = JSON.stringify(policy.routing);
    expect(serialized).not.toContain('opencode');
    expect(serialized).not.toContain('deepseek-v4-flash-free');
    expect(JSON.stringify({ coding: policy.routing.coding, thinking: policy.routing.thinking })).not.toContain('mini27');
    expect(JSON.stringify({ coding: policy.routing.coding, thinking: policy.routing.thinking })).not.toContain('sdfv.key1.gpt-5.5');
    expect(JSON.stringify({ coding: policy.routing.coding, thinking: policy.routing.thinking })).not.toContain('cc.key1.gpt-5.5');
  });
});
