import {
  containsBroadKillCommand,
  validateCanonicalClientToolCall
} from '../../src/server/runtime/http-server/executor/provider-response-tool-validation-blocks.js';

describe('provider-response-tool-validation-blocks apply_patch normalization', () => {
  it('keeps exec_command cmd exact and does not treat privileged shell text as broad kill', () => {
    const cmd = [
      'osascript -e \'do shell script "echo APPLESCRIPT_AUTH_OK" with administrator privileges\' 2>&1',
      'echo "---"',
      'cat /tmp/hosts_test 2>&1',
      'echo "186.241.81.215 api2.codewhisper.cc" | sudo -S tee -a /etc/hosts 2>/dev/null',
      'echo "post-sudo:"; tail -3 /etc/hosts'
    ].join('\n');
    expect(containsBroadKillCommand(cmd)).toBe(false);
    const result = validateCanonicalClientToolCall('exec_command', JSON.stringify({ cmd }));
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.normalizedArgs || '{}') as Record<string, unknown>;
    expect(parsed.cmd).toBe(cmd);
  });

  it('still blocks true broad kill command patterns', () => {
    expect(containsBroadKillCommand('ps aux | xargs kill')).toBe(true);
    expect(containsBroadKillCommand('kill $(pgrep node)')).toBe(true);
  });

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
