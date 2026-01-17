import { describe, expect, it } from '@jest/globals';
import { runCli } from '../../src/cli/main.js';

function createCaptureRuntime() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      writeOut: (text: string) => out.push(text),
      writeErr: (text: string) => err.push(text)
    },
    getStdout: () => out.join(''),
    getStderr: () => err.join('')
  };
}

describe('cli smoke', () => {
  it('--help returns 0 and prints help', async () => {
    const cap = createCaptureRuntime();
    const code = await runCli(['node', 'rcc', '--help'], {
      pkgName: 'rcc',
      cliVersion: '0.0.0-test',
      runtime: cap.runtime
    });
    expect(code).toBe(0);
    expect(cap.getStdout()).toContain('RouteCodex CLI');
    expect(cap.getStderr()).toBe('');
  });

  it('unknown command returns non-zero and prints error', async () => {
    const cap = createCaptureRuntime();
    const code = await runCli(['node', 'rcc', 'definitely-not-a-command'], {
      pkgName: 'rcc',
      cliVersion: '0.0.0-test',
      runtime: cap.runtime
    });
    expect(code).toBeGreaterThan(0);
    expect(cap.getStderr().toLowerCase()).toContain('unknown command');
  });
});

