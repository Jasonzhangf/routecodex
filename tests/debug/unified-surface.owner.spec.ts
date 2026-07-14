import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';

describe('debug unified surface owner gate M0/M1', () => {
  it('wires the unified debug verify script through package.json', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['verify:debug-unified-surface']).toBe(
      'node scripts/verify-debug-unified-surface.mjs',
    );
  });

  it('anchors the M1 diag artifact surface under src/debug', () => {
    const debugIndex = fs.readFileSync('src/debug/index.ts', 'utf8');
    const diagIndex = fs.readFileSync('src/debug/diag/index.ts', 'utf8');
    const verifyScript = fs.readFileSync('scripts/verify-debug-unified-surface.mjs', 'utf8');

    expect(debugIndex).toContain("export * from './diag/index.js';");
    expect(diagIndex).toMatch(/from\s+'\.\/error-artifact\.js'/);
    expect(diagIndex).toMatch(/readDebugErrorDiagArtifactInternal\s+as\s+readDebugErrorDiagArtifact/);
    expect(diagIndex).toMatch(/writeDebugErrorDiagArtifactInternal\s+as\s+writeDebugErrorDiagArtifact/);
    expect(debugIndex).toContain('export async function readDebugErrorDiagArtifact');
    expect(debugIndex).toContain('export async function writeDebugErrorDiagArtifact');
    expect(verifyScript).toContain('writeDebugErrorDiagArtifact');
  });
});
