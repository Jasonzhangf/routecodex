import { resolveCompatibilityModuleTypes } from '../standard-compatibility-utils.js';

describe('resolveCompatibilityModuleTypes', () => {
  it('returns declared profiles when present', () => {
    const types = resolveCompatibilityModuleTypes({
      profiles: ['glm.tool-cleaning', 'glm.field-mapping']
    });
    expect(types).toEqual(['glm.tool-cleaning', 'glm.field-mapping']);
  });

  it('falls back to moduleType when profiles absent', () => {
    const types = resolveCompatibilityModuleTypes({
      moduleType: 'passthrough-compatibility'
    });
    expect(types).toEqual(['passthrough-compatibility']);
  });

  it('defaults to passthrough when configuration empty', () => {
    const types = resolveCompatibilityModuleTypes({});
    expect(types).toEqual(['passthrough-compatibility']);
  });
});
