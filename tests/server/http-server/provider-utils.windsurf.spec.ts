import { describe, expect, it } from '@jest/globals';

import {
  mapProviderProtocol,
  resolveProviderIdentity
} from '../../../src/server/runtime/http-server/provider-utils.js';

describe('provider-utils windsurf mapping', () => {
  it('keeps windsurf canonical provider type openai with explicit windsurf family', () => {
    const identity = resolveProviderIdentity('windsurf');
    expect(identity.providerType).toBe('openai');
    expect(identity.providerFamily).toBe('windsurf');
  });

  it('RED: maps windsurf provider family to responses client protocol so /v1/responses remap cannot leak chat choices', () => {
    expect(mapProviderProtocol('openai', 'windsurf')).toBe('openai-responses');
  });
});
