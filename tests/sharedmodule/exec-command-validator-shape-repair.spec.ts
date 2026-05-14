import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

describe('exec_command validator shape repair', () => {
  it('unwraps nested input.cmd shape into canonical cmd', () => {
    const result = validateToolCall('exec_command', JSON.stringify({ input: { cmd: 'pwd', workdir: '/workspace' } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = JSON.parse(String(result.normalizedArgs || '{}'));
      expect(normalized.cmd).toBe('pwd');
      expect(normalized.workdir).toBe('/workspace');
    }
  });

  it('unwraps nested arguments.command shape into canonical cmd', () => {
    const result = validateToolCall(
      'exec_command',
      JSON.stringify({ arguments: { command: 'ls -la', yield_time_ms: 500 } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = JSON.parse(String(result.normalizedArgs || '{}'));
      expect(normalized.cmd).toBe('ls -la');
      expect(normalized.yield_time_ms).toBe(500);
    }
  });

  it('rejects command alias in canonical schema mode', () => {
    const result = validateToolCall(
      'exec_command',
      JSON.stringify({ command: 'ls -la', yield_time_ms: 500 }),
      { schemaMode: 'canonical' }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_cmd');
  });

  it('rejects nested input.cmd shape in canonical schema mode', () => {
    const result = validateToolCall(
      'exec_command',
      JSON.stringify({ input: { cmd: 'pwd', workdir: '/workspace' } }),
      { schemaMode: 'canonical' }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_cmd');
  });

  it('repairs zero-ambiguity tail-truncated shell wrapper by restoring the missing closing quote', () => {
    const result = validateToolCall(
      'exec_command',
      JSON.stringify({
        cmd: "bash -lc 'tail -50 ~/.fin/runtime/peers/qqbot/bridge.stderr.log 2>/dev/null || echo \"No bridge log\""
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = JSON.parse(String(result.normalizedArgs || '{}'));
      expect(normalized.cmd).toBe("bash -lc 'tail -50 ~/.fin/runtime/peers/qqbot/bridge.stderr.log 2>/dev/null || echo \"No bridge log\"'");
    }
  });

  it('allows zero-ambiguity shell wrapper spacing normalization elsewhere but keeps balanced wrappers valid', () => {
    const result = validateToolCall(
      'exec_command',
      JSON.stringify({
        cmd: "bash -lc 'pwd'"
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = JSON.parse(String(result.normalizedArgs || '{}'));
      expect(normalized.cmd).toBe("bash -lc 'pwd'");
    }
  });
});
