import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const httpServerSourceDir = path.resolve(
  __dirname,
  '../../../../src/server/runtime/http-server'
);

describe('http-server source generated residue cleanup', () => {
  it('does not keep tracked stats-manager JS or declaration artifacts in the source tree', () => {
    const forbiddenArtifacts = [
      'stats-manager.js',
      'stats-manager.d.ts',
      'stats-manager-internals.js',
      'stats-manager-internals.d.ts',
      'stats-manager-table.js',
      'stats-manager-table.d.ts'
    ];

    for (const artifact of forbiddenArtifacts) {
      expect(fs.existsSync(path.join(httpServerSourceDir, artifact))).toBe(false);
    }
  });

  it('does not keep tracked usage-aggregator JS or declaration artifacts in the source tree', () => {
    const forbiddenArtifacts = [
      'executor/usage-aggregator.js',
      'executor/usage-aggregator.d.ts'
    ];

    for (const artifact of forbiddenArtifacts) {
      expect(fs.existsSync(path.join(httpServerSourceDir, artifact))).toBe(false);
    }
  });
});
