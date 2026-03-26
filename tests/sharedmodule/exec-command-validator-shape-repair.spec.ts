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
});
