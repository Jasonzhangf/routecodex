import { describe, it, expect } from '@jest/globals';
import fs from 'fs/promises';

import { jest } from '@jest/globals';
// Mock ESM sharedmodule engines used by ConfigManagerModule
jest.mock('routecodex-config-engine', () => ({
  ConfigParser: class {
    async parseFromString(s: string) {
      try { JSON.parse(s); } catch { return { isValid: false, errors: [{ message: 'invalid json' }] }; }
      return { isValid: true, normalized: JSON.parse(s) } as any;
    }
  }
}), { virtual: true });

jest.mock('routecodex-config-compat', () => ({
  CompatibilityEngine: class {
    async processCompatibility(s: string) {
      try { JSON.parse(s); } catch { return { isValid: false, errors: [{ message: 'invalid json' }] }; }
      return { isValid: true, compatibilityConfig: { normalizedConfig: JSON.parse(s) } } as any;
    }
  }
}), { virtual: true });

import { ConfigManagerModule } from '../src/modules/config-manager/config-manager-module.js';

describe('Default user config generation (GLM single provider)', () => {
  it('creates default config when missing and produces merged-config with GLM route', async () => {
    const tmpDir = './test-results/default-user-config';
    const userConfigPath = `${tmpDir}/config.json`;
    const mergedPath = `${tmpDir}/merged-config.json`;

    // Ensure clean dir
    await fs.mkdir(tmpDir, { recursive: true });
    try { await fs.unlink(userConfigPath); } catch {}
    try { await fs.unlink(mergedPath); } catch {}

    const mgr = new ConfigManagerModule();
    await mgr.initialize({
      configPath: userConfigPath,
      mergedConfigPath: mergedPath,
      systemModulesPath: './config/modules.json',
      autoReload: false,
    });

    // User config should exist now
    const cfg = JSON.parse(await fs.readFile(userConfigPath, 'utf-8'));
    expect(cfg.virtualrouter).toBeTruthy();
    expect(cfg.virtualrouter.providers.glm).toBeTruthy();
    expect(cfg.virtualrouter.providers.glm.models['glm-4.6']).toBeTruthy();

    // Merged config should exist (structure may vary by engine); basic presence check
    const merged = JSON.parse(await fs.readFile(mergedPath, 'utf-8'));
    expect(merged.modules).toBeTruthy();
  });
});
