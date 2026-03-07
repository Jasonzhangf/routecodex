import { runNonBlockingCredentialValidation } from '../../../../src/providers/core/runtime/provider-startup-tasks.js';

describe('provider startup tasks', () => {
  it('runs credential validation without blocking startup', async () => {
    let started = false;

    await Promise.race([
      Promise.resolve(runNonBlockingCredentialValidation(async () => {
        started = true;
        await new Promise(() => {});
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('non-blocking scheduling timed out')), 200))
    ]);

    await Promise.resolve();
    expect(started).toBe(true);
  });

  it('swallows startup validation errors', async () => {
    await expect(async () => {
      runNonBlockingCredentialValidation(async () => {
        throw new Error('boom');
      });
      await Promise.resolve();
    }).not.toThrow();
  });
});
