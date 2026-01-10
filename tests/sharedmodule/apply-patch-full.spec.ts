import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

const toArgsObject = (result: { normalizedArgs?: string }): Record<string, unknown> => {
  if (!result.normalizedArgs) {
    return {};
  }
  return JSON.parse(result.normalizedArgs) as Record<string, unknown>;
};

describe('apply_patch full coverage', () => {
  it('accepts structured insert_after change', () => {
    const args = JSON.stringify({
      file: 'src/foo.ts',
      changes: [
        {
          kind: 'insert_after',
          anchor: 'const foo = 1;',
          lines: ['const bar = 2;']
        }
      ]
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
    expect(parsed.patch).toContain('*** Update File: src/foo.ts');
    expect(parsed.patch).toContain('+const bar = 2;');
  });

  it('supports replace change without top-level file', () => {
    const args = JSON.stringify({
      changes: [
        {
          file: 'src/bar.ts',
          kind: 'replace',
          target: 'const status = "old";',
          lines: ['const status = "new";']
        }
      ]
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Update File: src/bar.ts');
    expect(parsed.patch).toContain('-const status = "old";');
    expect(parsed.patch).toContain('+const status = "new";');
  });

  it('rejects payloads without changes', () => {
    const args = JSON.stringify({ file: 'src/foo.ts' });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_changes');
  });

  it('rejects empty changes array', () => {
    const args = JSON.stringify({ file: 'src/foo.ts', changes: [] });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_changes');
  });

  it('supports create_file change', () => {
    const args = JSON.stringify({
      changes: [
        {
          kind: 'create_file',
          file: 'src/new-file.ts',
          lines: ['export const foo = 1;']
        }
      ]
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Add File: src/new-file.ts');
    expect(parsed.patch).toContain('+export const foo = 1;');
  });

  it('rejects invalid change kind', () => {
    const args = JSON.stringify({
      changes: [
        {
          kind: 'invalid_kind',
          file: 'src/test.ts'
        }
      ]
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(false);
  });
});
