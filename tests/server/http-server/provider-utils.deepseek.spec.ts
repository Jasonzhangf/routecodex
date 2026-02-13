import { describe, expect, it } from '@jest/globals';

import {
  mapProviderModule,
  mapProviderProtocol,
  resolveProviderIdentity
} from '../../../src/server/runtime/http-server/provider-utils.js';

describe('provider-utils deepseek mapping', () => {
  it('canonicalizes deepseek family to openai type', () => {
    const identity = resolveProviderIdentity('deepseek');
    expect(identity.providerType).toBe('openai');
    expect(identity.providerFamily).toBe('deepseek');
  });

  it('maps deepseek to openai module/protocol', () => {
    expect(mapProviderModule('deepseek')).toBe('deepseek-http-provider');
    expect(mapProviderProtocol('deepseek')).toBe('openai-chat');
  });
});
