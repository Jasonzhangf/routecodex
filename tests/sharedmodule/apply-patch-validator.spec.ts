import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

const toArgsObject = (result: { normalizedArgs?: string }): Record<string, unknown> => {
  if (!result.normalizedArgs) {
    return {};
  }
  return JSON.parse(result.normalizedArgs) as Record<string, unknown>;
};

describe('apply_patch validator', () => {
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

  it('accepts classic context diff by converting to apply_patch format', () => {
    const contextDiff = [
      '*** src/foo.ts',
      '--- src/foo.ts',
      '***************',
      '*** 1,2 ****',
      '! const a = 1;',
      '--- 1,2 ----',
      '! const a = 2;'
    ].join('\n');
    const args = JSON.stringify({ patch: contextDiff });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Begin Patch');
    expect(String(parsed.patch)).toContain('*** Update File: src/foo.ts');
    expect(String(parsed.patch)).toContain('-const a = 1;');
    expect(String(parsed.patch)).toContain('+const a = 2;');
  });

  it('rejects invalid json args (even when containing <arg_key>/<arg_value> artifacts)', () => {
    const brokenArgs =
      '{"file":"a.ts","changes":[{"kind":"create_file","lines":["x"],"file</arg_key><arg_value>a.ts"}]}';
    const result = validateToolCall('apply_patch', brokenArgs);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_json');
  });

  it('converts unified diff wrapped in "*** Begin Patch ***" markers into apply_patch format', () => {
    const wrappedUnifiedDiff = [
      '*** Begin Patch ***',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '*** End Patch ***'
    ].join('\n');
    const args = JSON.stringify({ patch: wrappedUnifiedDiff });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Begin Patch');
    expect(String(parsed.patch)).toContain('*** Update File: src/foo.ts');
    expect(String(parsed.patch)).toContain('-const a = 1;');
    expect(String(parsed.patch)).toContain('+const a = 2;');
  });
});
