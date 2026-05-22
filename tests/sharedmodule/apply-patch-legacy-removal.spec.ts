import { describe, expect, it } from '@jest/globals';

describe('apply_patch legacy removal contract', () => {
  it('physically removes the old TS structured apply_patch implementation files', async () => {
    await expect(
      import('../../sharedmodule/llmswitch-core/src/tools/apply-patch/structured.js')
    ).rejects.toThrow();
    await expect(
      import('../../sharedmodule/llmswitch-core/src/tools/apply-patch/structured/coercion.js')
    ).rejects.toThrow();
  });
});
