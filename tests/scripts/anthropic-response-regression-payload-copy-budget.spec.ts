import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

const scriptPath = path.resolve(
  process.cwd(),
  'sharedmodule/llmswitch-core/scripts/tests/anthropic-response-regression.mjs'
);

describe('feature_id: debug.anthropic_response_regression_payload_copy_budget', () => {
  test('regression script binds the Rust native owner without clone or deleted TS runtime detour', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain('buildAnthropicRegressionProjectionWithNative');
    expect(source).toContain('buildOpenAIChatFromAnthropicMessageFullWithNative');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('response-runtime-anthropic.js');
    expect(source).not.toContain('resolveDistPath(');
    expect(source).toContain("if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)");
  });

  test('module import does not execute the native regression', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `import ${JSON.stringify(scriptPath)};`
    });

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('direct CLI replays the tracked sample through the real native owner', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Hub Anthropic response mapping matches Rust-owned shape.');
    expect(result.status).toBe(0);
  });
});
