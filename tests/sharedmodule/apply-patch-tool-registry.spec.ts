import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

const toArgsObject = (result: { normalizedArgs?: string }): Record<string, unknown> => {
  if (!result.normalizedArgs) {
    return {};
  }
  return JSON.parse(result.normalizedArgs) as Record<string, unknown>;
};

describe('tool-registry apply_patch validation', () => {
  it('validates apply_patch through the apply_patch validator', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: README.md',
      '@@',
      ' old',
      '+new',
      '*** End Patch'
    ].join('\n');
    const result = validateToolCall('apply_patch', JSON.stringify({ patch }));
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
  });

  it('rejects malformed apply_patch as patch shape instead of unknown tool', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: README.md',
      '@@'
    ].join('\n');
    const result = validateToolCall('apply_patch', JSON.stringify({ patch }));
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBe('unknown_tool');
  });
});
