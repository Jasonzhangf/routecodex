import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

const toArgsObject = (result: { normalizedArgs?: string }): Record<string, unknown> => {
  if (!result.normalizedArgs) {
    return {};
  }
  return JSON.parse(result.normalizedArgs) as Record<string, unknown>;
};

describe('tool-registry apply_patch validation', () => {
  it('validates apply_patch through the native apply_patch verdict', () => {
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
    expect(parsed.input).toBe(parsed.patch);
  });

  it('repairs malformed update patch shape via native verdict instead of surfacing unknown tool', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: README.md',
      '@@'
    ].join('\n');
    const result = validateToolCall('apply_patch', JSON.stringify({ patch }));
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toBe([
      '*** Begin Patch',
      '*** Update File: README.md',
      '@@',
      '*** End Patch'
    ].join('\n'));
  });

  it('repairs add-file blocks by plus-prefixing content via native verdict', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: demo.txt',
      'hello',
      '*** End Patch'
    ].join('\n');
    const result = validateToolCall('apply_patch', JSON.stringify({ patch }));
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toBe([
      '*** Begin Patch',
      '*** Add File: demo.txt',
      '+hello',
      '*** End Patch'
    ].join('\n'));
  });

  it('rejects hashline payloads missing fileContent through the native apply_patch verdict', () => {
    const result = validateToolCall(
      'apply_patch',
      JSON.stringify({
        patch: '+ 2 deadbeef\nhello',
        filePath: 'note.txt'
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hashline_missing_file_content');
  });

  it('rejects hashline payloads missing filePath through the native apply_patch verdict', () => {
    const result = validateToolCall(
      'apply_patch',
      JSON.stringify({
        patch: '+ 2 deadbeef\nhello',
        fileContent: 'hello'
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hashline_missing_file_path');
  });

  it('accepts canonical update patch with stray filePath as repairable shape', () => {
    const result = validateToolCall(
      'apply_patch',
      JSON.stringify({
        filePath: 'test_apply_patch/sample.txt',
        input: '*** Begin Patch\n*** Update File: test_apply_patch/sample.txt\n@@ -1,3 +1,3 @@\n Original line 1\n-Original line 2\n+Modified line 2: UPDATED!\n Original line 3\n*** End Patch',
        patch: '*** Begin Patch\n*** Update File: test_apply_patch/sample.txt\n@@ -1,3 +1,3 @@\n Original line 1\n-Original line 2\n+Modified line 2: UPDATED!\n Original line 3\n*** End Patch'
      })
    );
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
    expect(parsed.patch).toContain('*** Update File: test_apply_patch/sample.txt');
    expect(parsed.input).toBe(parsed.patch);
  });

  it('accepts canonical add-file patch with stray filePath as repairable shape', () => {
    const result = validateToolCall(
      'apply_patch',
      JSON.stringify({
        filePath: 'test_apply_patch/new_file.txt',
        patch: '*** Begin Patch\n*** Add File: test_apply_patch/new_file.txt\n+Line 1: This is a new file\n+Line 2: Testing add file functionality\n+Line 3: All systems go\n*** End Patch'
      })
    );
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.patch).toContain('*** Begin Patch');
    expect(parsed.patch).toContain('*** Add File: test_apply_patch/new_file.txt');
    expect(parsed.input).toBe(parsed.patch);
  });

  it('accepts newline-escaped raw patch string without first losing request shape to empty object', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: escaped.txt',
      '+hello',
      '*** End Patch'
    ].join('\\n');
    const result = validateToolCall('apply_patch', patch);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch || '')).toContain('*** Begin Patch');
    expect(String(parsed.patch || '')).toContain('*** Add File: escaped.txt');
    expect(String(parsed.patch || '')).toContain('\n');
  });

  it('repairs arg_key invalid-json artifact through raw request string instead of collapsing request shape to empty object', () => {
    const invalidJson = '{"file":"a.ts","changes":[{"kind":"create_file","lines":["x"],"file</arg_key><arg_value>a.ts"}]}';
    const result = validateToolCall('apply_patch', invalidJson);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(String(parsed.patch || '')).toContain('*** Add File: a.ts');
    expect(String(parsed.patch || '')).toContain('+x');
  });
});
