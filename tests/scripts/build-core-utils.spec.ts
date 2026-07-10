import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createRequiredCoreOutputs, distIsValid } = await import('../../scripts/lib/build-core-utils.mjs');

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'export {};\n', 'utf8');
}

describe('build-core required llmswitch dist outputs', () => {
  it('rejects old dist snapshots missing native shared conversion core module', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-build-core-old-dist-'));
    const outDir = path.join(root, 'dist');
    for (const required of createRequiredCoreOutputs(outDir)) {
      if (required.endsWith('native-shared-conversion-semantics-core.js')) {
        continue;
      }
      touch(required);
    }

    expect(distIsValid(outDir)).toBe(false);
  });

  it('accepts dist only when the native shared conversion core module is present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-build-core-valid-dist-'));
    const outDir = path.join(root, 'dist');
    for (const required of createRequiredCoreOutputs(outDir)) {
      touch(required);
    }

    expect(distIsValid(outDir)).toBe(true);
  });
});
