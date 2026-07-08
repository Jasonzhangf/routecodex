import fs from 'fs';
import os from 'os';
import path from 'path';

import { bootstrapProvidersWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-providers.js';

describe('virtual-router native provider auth bootstrap', () => {
  const prevAuthDir = process.env.RCC_AUTH_DIR;
  const prevRoutecodexAuthDir = process.env.ROUTECODEX_AUTH_DIR;
  let authDir = '';

  beforeEach(() => {
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-provider-auth-'));
    process.env.RCC_AUTH_DIR = authDir;
    process.env.ROUTECODEX_AUTH_DIR = authDir;
    fs.writeFileSync(path.join(authDir, 'provider-key-1.json'), '{}\n');
    fs.writeFileSync(path.join(authDir, 'provider-key-4.json'), '{}\n');
  });

  afterEach(() => {
    if (prevAuthDir === undefined) {
      delete process.env.RCC_AUTH_DIR;
    } else {
      process.env.RCC_AUTH_DIR = prevAuthDir;
    }
    if (prevRoutecodexAuthDir === undefined) {
      delete process.env.ROUTECODEX_AUTH_DIR;
    } else {
      process.env.ROUTECODEX_AUTH_DIR = prevRoutecodexAuthDir;
    }
    if (authDir) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it('keeps explicit apikey tokenFile providers single-entry instead of expanding the full pool', () => {
    const result = bootstrapProvidersWithNative({
      providersSource: {
        'provider-explicit': {
          type: 'openai',
          baseURL: 'https://example.invalid/v1',
          compatibilityProfile: 'compat:passthrough',
          auth: { type: 'apikey', tokenFile: 'provider-key-4' },
          models: {
            'model-a': {}
          }
        }
      }
    });

    expect(Object.keys(result.runtimeEntries).filter((key) => key.startsWith('provider-explicit.'))).toEqual([
      'provider-explicit.key1'
    ]);
    expect(result.runtimeEntries['provider-explicit.key1']?.auth?.tokenFile).toBe('provider-key-4');
    expect(result.aliasIndex.get('provider-explicit')).toEqual(['key1']);
  });

  it('ignores empty auth.entries records instead of materializing phantom key aliases', () => {
    const result = bootstrapProvidersWithNative({
      providersSource: {
        'provider-entries': {
          type: 'openai',
          baseURL: 'https://example.invalid/v1',
          compatibilityProfile: 'compat:passthrough',
          auth: {
            type: 'apikey',
            entries: [
              {},
              {
                alias: 'primary',
                type: 'apikey',
                tokenFile: '~/.rcc/auth/provider-primary.json'
              }
            ]
          },
          models: {
            'model-a': {}
          }
        }
      }
    });

    expect(Object.keys(result.runtimeEntries).filter((key) => key.startsWith('provider-entries.'))).toEqual([
      'provider-entries.primary'
    ]);
    expect(result.aliasIndex.get('provider-entries')).toEqual(['primary']);
    expect(result.runtimeEntries['provider-entries.key1']).toBeUndefined();
  });
});
