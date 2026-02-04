import { describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  markInteractiveOAuthRepairAttempt,
  shouldSkipInteractiveOAuthRepair
} from '../../../src/providers/auth/oauth-repair-cooldown.js';

describe('oauth-repair-cooldown', () => {
  test('enforces cooldown for google_verify and clears after window', async () => {
    const prevHome = process.env.HOME;
    const prevCooldown = process.env.ROUTECODEX_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS;
    const nowSpy = jest.spyOn(Date, 'now');

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-oauth-cooldown-'));
    process.env.HOME = tmp;
    process.env.ROUTECODEX_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS = '1000';

    const providerType = 'antigravity';
    const tokenFile = path.join(tmp, 'auth', 'antigravity-oauth-1-a.json');

    nowSpy.mockReturnValue(1_000_000);
    await markInteractiveOAuthRepairAttempt({ providerType, tokenFile, reason: 'google_verify' });

    nowSpy.mockReturnValue(1_000_500);
    const gate1 = await shouldSkipInteractiveOAuthRepair({ providerType, tokenFile, reason: 'google_verify' });
    expect(gate1.skip).toBe(true);

    nowSpy.mockReturnValue(1_001_600);
    const gate2 = await shouldSkipInteractiveOAuthRepair({ providerType, tokenFile, reason: 'google_verify' });
    expect(gate2.skip).toBe(false);

    nowSpy.mockRestore();
    if (prevCooldown === undefined) delete process.env.ROUTECODEX_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS;
    else process.env.ROUTECODEX_OAUTH_GOOGLE_VERIFY_COOLDOWN_MS = prevCooldown;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
});

