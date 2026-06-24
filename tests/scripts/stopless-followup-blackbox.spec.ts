import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';

describe('stopless followup blackbox gate', () => {
  test('RED: stopless continuation stays client-driven and does not reenter server-side followup', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/tests/stopless-followup-blackbox.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH ?? ''}`,
        }
      }
    );

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    }).toMatchObject({
      status: 0
    });
  }, 120000);
});
