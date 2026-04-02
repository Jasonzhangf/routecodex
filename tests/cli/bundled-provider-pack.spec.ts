import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installBundledProviderPackBestEffort } from '../../src/cli/config/bundled-provider-pack.js';

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

describe('bundled provider pack installer', () => {
  it('returns missing_source when source dir is not found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-provider-pack-missing-'));
    const result = installBundledProviderPackBestEffort({
      sourceDir: path.join(root, 'not-found'),
      providerRoot: path.join(root, 'provider')
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_source');
    }
  });

  it('copies providers from manifest and respects overwriteExisting flag', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-provider-pack-'));
    const sourceDir = path.join(root, 'source');
    const providerRoot = path.join(root, 'provider');

    writeJson(path.join(sourceDir, 'manifest.json'), {
      version: '1.0.0',
      profile: 'default',
      providers: ['alpha', 'beta']
    });
    writeJson(path.join(sourceDir, 'alpha', 'config.v2.json'), {
      version: '2.0.0',
      providerId: 'alpha',
      provider: { id: 'alpha', enabled: true, type: 'openai' }
    });
    writeJson(path.join(sourceDir, 'beta', 'config.v2.json'), {
      version: '2.0.0',
      providerId: 'beta',
      provider: { id: 'beta', enabled: true, type: 'openai', marker: 'new' }
    });
    writeJson(path.join(providerRoot, 'beta', 'config.v2.json'), {
      version: '2.0.0',
      providerId: 'beta',
      provider: { id: 'beta', enabled: true, type: 'openai', marker: 'old' }
    });

    const first = installBundledProviderPackBestEffort({
      sourceDir,
      providerRoot,
      overwriteExisting: false
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.copiedProviders).toEqual(['alpha']);
      expect(first.skippedProviders).toContain('beta');
    }

    const betaFirst = JSON.parse(fs.readFileSync(path.join(providerRoot, 'beta', 'config.v2.json'), 'utf8'));
    expect(betaFirst.provider.marker).toBe('old');

    const second = installBundledProviderPackBestEffort({
      sourceDir,
      providerRoot,
      overwriteExisting: true
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.copiedProviders).toContain('beta');
    }

    const betaSecond = JSON.parse(fs.readFileSync(path.join(providerRoot, 'beta', 'config.v2.json'), 'utf8'));
    expect(betaSecond.provider.marker).toBe('new');
  });
});
