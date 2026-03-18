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

  it('repairs deterministic missing-colon json when containing <arg_key>/<arg_value> artifacts', () => {
    const brokenArgs =
      '{"file":"a.ts","changes":[{"kind":"create_file","lines":["x"],"file</arg_key><arg_value>a.ts"}]}';
    const result = validateToolCall('apply_patch', brokenArgs);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Add File: a.ts');
    expect(String(parsed.patch)).toContain('+x');
  });

  it('rejects irrecoverable malformed json with broken <arg_key>/<arg_value> artifacts', () => {
    const unrecoverable =
      '{"file":"a.ts","changes":[{"kind":"create_file","lines":["x"],"file</arg_key><arg_value>a.ts}]}';
    const result = validateToolCall('apply_patch', unrecoverable);
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

  it('converts context diff wrapped in Begin/End Patch markers into apply_patch format', () => {
    const wrappedContextDiff = [
      '*** Begin Patch',
      '*** a/src/foo.ts',
      '--- b/src/foo.ts',
      '***************',
      '*** 1,2 ****',
      '  const a = 1;',
      '! const b = 1;',
      '--- 1,2 ----',
      '  const a = 1;',
      '! const b = 2;',
      '*** End Patch'
    ].join('\n');

    const args = JSON.stringify({ patch: wrappedContextDiff });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Begin Patch');
    expect(String(parsed.patch)).toContain('*** Update File: src/foo.ts');
    expect(String(parsed.patch)).toContain('-const b = 1;');
    expect(String(parsed.patch)).toContain('+const b = 2;');
    expect(String(parsed.patch)).toContain('*** End Patch');
  });

  it('normalizes malformed unified markers (++++ / @@@@) from errorsamples', () => {
    const malformedAddDiff = [
      '*** Begin Patch',
      '--- /dev/null',
      '++++ DELIVERY.md',
      '@@@@',
      '+## delivery',
      '+- item',
      '*** End Patch'
    ].join('\n');

    const args = JSON.stringify({ patch: malformedAddDiff });
    const result = validateToolCall('apply_patch', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Begin Patch');
    expect(String(parsed.patch)).toContain('*** Add File: DELIVERY.md');
    expect(String(parsed.patch)).toContain('+## delivery');
    expect(String(parsed.patch)).toContain('*** End Patch');
  });

  it('rejects Update File blocks without @@ (strict syntax, no semantic guessing)', () => {
    const malformedUpdate = [
      '*** Begin Patch',
      '*** Update File: HEARTBEAT.md',
      '---',
      'title: "finger project heartbeat"',
      'updated_at: "2026-03-17T10:36:00+08:00"',
      '---',
      '*** End Patch'
    ].join('\n');

    const result = validateToolCall('apply_patch', JSON.stringify({ patch: malformedUpdate }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_patch_format');
  });

  it('safely inserts @@ when Update File already contains explicit +/- diff lines', () => {
    const missingHunk = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      ' const keep = 1;',
      '-const oldValue = 1;',
      '+const oldValue = 2;',
      '*** End Patch'
    ].join('\n');

    const result = validateToolCall('apply_patch', JSON.stringify({ patch: missingHunk }));
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Update File: src/a.ts');
    expect(String(parsed.patch)).toContain('\n@@\n');
    expect(String(parsed.patch)).toContain('-const oldValue = 1;');
    expect(String(parsed.patch)).toContain('+const oldValue = 2;');
  });

  it('supports CRLF + tab separators in GNU diff headers', () => {
    const gnuWithTabs = [
      '--- a/HEARTBEAT.md\t2026-03-17 10:36:00 +0800',
      '+++ b/HEARTBEAT.md\t2026-03-17 10:39:00 +0800',
      '@@ -1,2 +1,2 @@',
      '-title: "old"',
      '+title: "new"'
    ].join('\r\n');

    const result = validateToolCall('apply_patch', JSON.stringify({ patch: gnuWithTabs }));
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch)).toContain('*** Update File: HEARTBEAT.md');
    expect(String(parsed.patch)).toContain('@@ -1,2 +1,2 @@');
    expect(String(parsed.patch)).toContain('+title: "new"');
  });

  it('rejects empty Add File blocks to avoid accidental empty file creation', () => {
    const emptyAdd = [
      '*** Begin Patch',
      '*** Add File: src/empty.txt',
      '*** End Patch'
    ].join('\n');

    const result = validateToolCall('apply_patch', JSON.stringify({ patch: emptyAdd }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_add_file_block');
  });

  it('rejects invalid /dev/null file path in Add File header', () => {
    const invalidPath = [
      '*** Begin Patch',
      '*** Add File: /dev/null',
      '+hello',
      '*** End Patch'
    ].join('\n');

    const result = validateToolCall('apply_patch', JSON.stringify({ patch: invalidPath }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_patch_path');
  });
});
