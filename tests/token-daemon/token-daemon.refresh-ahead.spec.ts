import { describe, expect, it } from '@jest/globals';

describe('TokenDaemon refreshAheadMinutes', () => {
  it('defaults to 30 minutes', async () => {
    const prevA = process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN;
    const prevB = process.env.RCC_TOKEN_REFRESH_AHEAD_MIN;
    delete process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN;
    delete process.env.RCC_TOKEN_REFRESH_AHEAD_MIN;
    try {
      const mod = await import('../../src/token-daemon/token-daemon.js');
      const daemon = new mod.TokenDaemon({ intervalMs: 999999 });
      expect((daemon as any).refreshAheadMinutes).toBe(30);
    } finally {
      if (prevA === undefined) delete process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN;
      else process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN = prevA;
      if (prevB === undefined) delete process.env.RCC_TOKEN_REFRESH_AHEAD_MIN;
      else process.env.RCC_TOKEN_REFRESH_AHEAD_MIN = prevB;
    }
  });

  it('respects env override', async () => {
    const prevA = process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN;
    const prevB = process.env.RCC_TOKEN_REFRESH_AHEAD_MIN;
    process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN = '12';
    delete process.env.RCC_TOKEN_REFRESH_AHEAD_MIN;
    try {
      const mod = await import('../../src/token-daemon/token-daemon.js');
      const daemon = new mod.TokenDaemon({ intervalMs: 999999 });
      expect((daemon as any).refreshAheadMinutes).toBe(12);
    } finally {
      if (prevA === undefined) delete process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN;
      else process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN = prevA;
      if (prevB === undefined) delete process.env.RCC_TOKEN_REFRESH_AHEAD_MIN;
      else process.env.RCC_TOKEN_REFRESH_AHEAD_MIN = prevB;
    }
  });
});

