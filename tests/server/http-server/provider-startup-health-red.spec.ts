import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * RED TESTS: Provider Startup Health
 *
 * These tests verify the startup health baseline:
 * 1. Startup reprobe must NOT be called
 * 2. persisted 503 cooldown/reprobe semantics must not remain in the routing truth
 *
 * All tests should FAIL before code changes, PASS after.
 */

describe('provider startup health (no persisted reprobe)', () => {
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

  it('RED: persisted 503 reprobe truth is no longer projected into health status', async () => {
    const healthPath = path.join(
      __dirname,
      '../../../sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs'
    );
    const content = await fs.readFile(healthPath, 'utf-8');
    expect(content).not.toContain('persisted_503_reprobe_available');
    expect(content).not.toContain('persisted_503_reprobe_state');
    expect(content).not.toContain('persisted_503_reprobe_at');
  });
});
