import { describe, expect, it } from '@jest/globals';

import { ensureLocalTokenPortalEnv, shutdownLocalTokenPortalEnv } from '../../src/token-portal/local-token-portal.js';

describe('local token portal', () => {
  it('exposes /health for OAuth portal readiness check', async () => {
    const base = await ensureLocalTokenPortalEnv();
    const root = new URL(base);
    const healthUrl = `${root.protocol}//${root.host}/health`;

    try {
      const response = await fetch(healthUrl);
      expect(response.status).toBe(200);
      const payload = await response.json() as { ok?: boolean };
      expect(payload.ok).toBe(true);
    } finally {
      await shutdownLocalTokenPortalEnv();
    }
  });
});
