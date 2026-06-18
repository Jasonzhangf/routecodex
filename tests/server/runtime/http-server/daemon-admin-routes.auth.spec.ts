import { describe, expect, it, jest } from '@jest/globals';

import {
  isDaemonAdminAuthRequired,
  rejectNonLocalOrUnauthorizedAdmin,
} from '../../../../src/server/runtime/http-server/daemon-admin-routes.js';

describe('daemon admin auth gate shell', () => {
  it('requires auth by default when no app policy is present', () => {
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      app: { locals: {} },
    } as any;

    expect(isDaemonAdminAuthRequired(req)).toBe(true);
  });

  it('fails closed with unauthorized when no daemon-admin auth state is established', () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const req = {
      socket: { remoteAddress: '10.0.0.8' },
      app: { locals: {} },
    } as any;
    const res = { status, json } as any;

    expect(rejectNonLocalOrUnauthorizedAdmin(req, res)).toBe(true);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { message: 'unauthorized', code: 'unauthorized' } });
  });
});
