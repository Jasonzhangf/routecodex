import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import path from 'node:path';

function runInstallVerifyMockConfig(timeoutMs: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'install-verify.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, '--launcher', 'repo', '--mode', 'responses', '--use-mock-config', '--timeout', '20'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ROUTECODEX_INSTALL_SKIP_PIPELINE_REGEN: '1',
          ROUTECODEX_INSTALL_VERIFY_PORT: '6520'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

describe('install-verify mock config', () => {
  it(
    'builds a mock config that boots virtual router with at least one provider',
    async () => {
      const result = await runInstallVerifyMockConfig(60_000);

      expect(result.code).toBe(0);
      expect(result.output).toContain('✅ server 健康检查通过');
      expect(result.output).not.toContain('Virtual Router requires at least one provider in configuration');
    },
    90_000
  );
});
