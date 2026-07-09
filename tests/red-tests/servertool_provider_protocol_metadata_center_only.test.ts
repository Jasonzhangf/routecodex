import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const retiredCarrierPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts'
);
const runtimeControlWriterPath = join(
  repoRoot,
  'sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts'
);

describe('servertool providerProtocol metadata center only boundary', () => {
  it('keeps the retired servertool metadata carrier physically deleted', () => {
    expect(existsSync(retiredCarrierPath)).toBe(false);
  });

  it('does not read flat providerProtocol shadows outside bound metadata center runtime_control', () => {
    expect(existsSync(runtimeControlWriterPath)).toBe(false);
  });
});
