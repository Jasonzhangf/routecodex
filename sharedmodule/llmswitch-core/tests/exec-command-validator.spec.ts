import { validateToolCall } from '../src/tools/tool-registry.js';

describe('exec_command validator (shape fixes)', () => {
  it('accepts raw string as cmd when args are not JSON', () => {
    const raw = 'ls -la';
    const res = validateToolCall('exec_command', raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const normalized = JSON.parse(res.normalizedArgs as string);
      expect(normalized.cmd).toBe('ls -la');
    }
  });

  it('accepts JSON args with cmd', () => {
    const args = JSON.stringify({ cmd: 'pwd' });
    const res = validateToolCall('exec_command', args);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const normalized = JSON.parse(res.normalizedArgs as string);
      expect(normalized.cmd).toBe('pwd');
    }
  });

  it('does not treat JSON-like string as raw cmd', () => {
    const args = '{"cmd":"echo hi"}';
    const res = validateToolCall('exec_command', args);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const normalized = JSON.parse(res.normalizedArgs as string);
      expect(normalized.cmd).toBe('echo hi');
    }
  });

  it('unwraps nested input.cmd shape into cmd', () => {
    const args = JSON.stringify({ input: { cmd: 'pwd', workdir: '/workspace' } });
    const res = validateToolCall('exec_command', args);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const normalized = JSON.parse(res.normalizedArgs as string);
      expect(normalized.cmd).toBe('pwd');
      expect(normalized.workdir).toBe('/workspace');
    }
  });

  it('unwraps nested arguments.command shape into cmd', () => {
    const args = JSON.stringify({ arguments: { command: 'ls -la', yield_time_ms: 500 } });
    const res = validateToolCall('exec_command', args);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const normalized = JSON.parse(res.normalizedArgs as string);
      expect(normalized.cmd).toBe('ls -la');
      expect(normalized.yield_time_ms).toBe(500);
    }
  });
});
