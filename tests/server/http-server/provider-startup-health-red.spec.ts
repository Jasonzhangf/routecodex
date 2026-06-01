import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * RED TESTS: Provider Startup Health
 *
 * These tests verify the new startup health design:
 * 1. Startup reprobe must NOT be called (replaced by persisted_503_reprobe_available)
 * 2. provider-startup-reprobe.ts file should be deleted
 *
 * All tests should FAIL before code changes, PASS after.
 */

describe('provider startup health (no reprobe)', () => {
  it('RED: startup reprobe is no longer imported in http-server-runtime-providers', async () => {
    const providersPath = path.join(
      __dirname,
      '../../../src/server/runtime/http-server/http-server-runtime-providers.ts'
    );
    const content = await fs.readFile(providersPath, 'utf-8');
    expect(content).not.toContain('runStartupProviderReprobe');
    expect(content).not.toMatch(/await\s+runStartupProviderReprobe\s*\(/);
  });

  it('RED: provider-startup-reprobe.ts file no longer exists', async () => {
    const reprobePath = path.join(
      __dirname,
      '../../../src/server/runtime/http-server/provider-startup-reprobe.ts'
    );
    await expect(fs.access(reprobePath)).rejects.toThrow();
  });
});
