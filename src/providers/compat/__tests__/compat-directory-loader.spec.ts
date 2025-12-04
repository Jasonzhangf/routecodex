import { registerCompatibilityModuleForTest } from '../compat-directory-loader.js';
import { CompatibilityModuleFactory } from '../compatibility-factory.js';

describe('compat-directory-loader', () => {
  it('registers exported modules', async () => {
    const typeName = `custom-${Date.now()}`;
    class CustomCompat {
      public readonly id = `${typeName}-id`;
      public readonly type = typeName;
      public readonly providerType = 'openai';
      async initialize() {}
      async processIncoming(request: unknown) { return request as any; }
      async processOutgoing(response: unknown) { return response as any; }
      async cleanup() {}
    }

    await registerCompatibilityModuleForTest({
      type: typeName,
      module: CustomCompat
    });

    expect(CompatibilityModuleFactory.isTypeRegistered(typeName)).toBe(true);
  });
});
