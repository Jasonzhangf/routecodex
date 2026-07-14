import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

const scriptPath = path.join(
  process.cwd(),
  'scripts/v2-consistency/comprehensive-consistency-test.mjs'
);

describe('feature_id: debug.v2_consistency_payload_copy_budget', () => {
  test('comprehensive consistency script keeps summary ownership without JSON round-trip clones', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain('runAllTests');
    expect(source).toContain('this.testResults.summary = await this.generateSummary();');
    expect(source).toContain('const summary = this.testResults.summary || {};');
    expect(source).not.toContain('JSON.parse(JSON.stringify');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toContain('deepClone(');
  });

  test('comprehensive consistency script remains parseable after clone cleanup', () => {
    const result = spawnSync(process.execPath, ['--check', scriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
