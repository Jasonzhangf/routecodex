import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const carrierPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts'
);

describe('servertool providerProtocol metadata center only boundary', () => {
  it('does not read flat providerProtocol shadows outside bound metadata center runtime_control', () => {
    const source = readFileSync(carrierPath, 'utf8');

    expect(source).not.toContain('const flat = target?.providerProtocol');
    expect(source).not.toContain('const nestedFlat = nested?.providerProtocol');
    expect(source).not.toContain('const nestedProtocol = nestedRuntimeControl?.providerProtocol');
  });
});
