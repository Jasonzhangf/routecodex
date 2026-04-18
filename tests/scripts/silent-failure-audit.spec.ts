import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from '@jest/globals';

describe('silent failure audit', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('flags catch blocks that silently return null or false', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-silent-audit-'));
    await fs.writeFile(
      path.join(tempRoot, 'sample.ts'),
      `
      export function readA(): string | null {
        try {
          return 'ok';
        } catch {
          return null;
        }
      }
      export function readB(): boolean {
        try {
          return true;
        } catch (error) {
          return false;
        }
      }
      `,
      'utf8'
    );

    const raw = execFileSync('node', ['scripts/ci/silent-failure-audit.mjs', '--json', '--root', tempRoot], {
      cwd: '/Users/fanzhang/Documents/github/routecodex',
      encoding: 'utf8'
    });
    const report = JSON.parse(raw) as {
      catchRiskCount: number;
      sample: Array<{ snippet: string }>;
    };

    expect(report.catchRiskCount).toBe(2);
    expect(report.sample.some((row) => row.snippet.includes('return null'))).toBe(true);
    expect(report.sample.some((row) => row.snippet.includes('return false'))).toBe(true);
  });

  it('flags promise catches that directly collapse to false', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-silent-audit-promise-'));
    await fs.writeFile(
      path.join(tempRoot, 'sample.ts'),
      `
      export async function readC(): Promise<boolean> {
        return Promise.resolve(true).catch(() => false);
      }
      `,
      'utf8'
    );

    const raw = execFileSync('node', ['scripts/ci/silent-failure-audit.mjs', '--json', '--root', tempRoot], {
      cwd: '/Users/fanzhang/Documents/github/routecodex',
      encoding: 'utf8'
    });
    const report = JSON.parse(raw) as {
      promiseCatchRiskCount: number;
      promiseSample: Array<{ snippet: string }>;
    };

    expect(report.promiseCatchRiskCount).toBe(1);
    expect(report.promiseSample[0]?.snippet).toContain('.catch(() => false)');
  });
});
