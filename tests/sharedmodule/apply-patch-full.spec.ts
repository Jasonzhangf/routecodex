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

  it('accepts toon arguments containing unified diff', () => {
    const toonPayload = {
      toon: '```apply_patch\n*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-const value = 1;\n+const value = 2;\n*** End Patch\n```'
    };
    const result = validateToolCall('apply_patch', JSON.stringify(toonPayload));
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
    expect(parsed.patch).toContain('+const value = 2;');
  });

  it('accepts raw unified diff string without JSON wrapper', () => {
    const rawPatch = [
      '*** Begin Patch',
      '*** Update File: src/raw.ts',
      '@@',
      '-const flag = false;',
      '+const flag = true;',
      '*** End Patch'
    ].join('\n');
    const result = validateToolCall('apply_patch', rawPatch);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('src/raw.ts');
    expect(parsed.patch).toContain('+const flag = true;');
  });

  it('accepts legacy single-change payload without changes array', () => {
    const args = JSON.stringify({
      file: 'src/legacy.ts',
      kind: 'replace',
      target: 'return foo;',
      lines: ['return bar;']
    });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Update File: src/legacy.ts');
    expect(parsed.patch).toContain('-return foo;');
    expect(parsed.patch).toContain('+return bar;');
  });
});
