import { validateCanonicalClientToolCall } from '../../src/server/runtime/http-server/executor/provider-response-tool-validation-blocks.js';

describe('provider-response-tool-validation-blocks apply_patch normalization', () => {
  it('mirrors patch into input when only patch is provided', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: tmp/apply-patch-mirror.txt',
      '+hello',
      '*** End Patch'
    ].join('\n');
    const result = validateCanonicalClientToolCall('apply_patch', JSON.stringify({ patch }));
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.normalizedArgs || '{}') as Record<string, unknown>;
    expect(parsed.patch).toBe(patch);
    expect(parsed.input).toBe(patch);
  });

  it('mirrors input into patch when only input is provided', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: tmp/apply-patch-alias.txt',
      '+hello',
      '*** End Patch'
    ].join('\n');
    const result = validateCanonicalClientToolCall('apply_patch', JSON.stringify({ input: patch }));
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.normalizedArgs || '{}') as Record<string, unknown>;
    expect(parsed.patch).toBe(patch);
    expect(parsed.input).toBe(patch);
  });
});
