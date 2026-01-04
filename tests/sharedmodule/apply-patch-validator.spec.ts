import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

const toArgsObject = (result: { normalizedArgs?: string }): Record<string, unknown> => {
  if (!result.normalizedArgs) {
    return {};
  }
  return JSON.parse(result.normalizedArgs) as Record<string, unknown>;
};

describe('apply_patch validator', () => {
  it('accepts canonical patch payloads', () => {
    const args = JSON.stringify({
      patch: [
        '*** Begin Patch',
        '*** Update File: src/foo.ts',
        '@@',
        '- old',
        '+ new',
        '*** End Patch'
      ].join('\n')
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
    expect(parsed.patch).toContain('*** End Patch');
    expect(parsed.paths).toBeUndefined();
  });

  it('wraps raw diff hunks when paths are provided', () => {
    const args = JSON.stringify({
      patch: '@@\n- console.log("old")\n+ console.log("new")',
      paths: ['src/utils/logger.ts']
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
    expect(parsed.patch).toContain('*** End Patch');
    expect(parsed.patch).toContain('*** Update File: src/utils/logger.ts');
    expect(parsed.paths).toEqual(['src/utils/logger.ts']);
  });

  it('overrides file headers with explicit paths', () => {
    const args = JSON.stringify({
      patch: [
        '*** Begin Patch',
        '*** Update File: tmp/placeholder.ts',
        '@@',
        '- old',
        '+ new',
        '*** End Patch'
      ].join('\n'),
      paths: ['src/placeholder.ts']
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Update File: src/placeholder.ts');
  });
});
