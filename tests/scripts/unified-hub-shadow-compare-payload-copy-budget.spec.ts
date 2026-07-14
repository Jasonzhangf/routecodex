import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/unified-hub-shadow-compare.mjs');

describe('unified hub shadow compare payload copy budget', () => {
  it('does not JSON-clone complete baseline and candidate payloads before diffing', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).not.toContain('JSON.parse(JSON.stringify');
    expect(source).not.toContain('function cloneJsonSafe');
    expect(source).toContain('diffPayloads(baselineOut, candidateOut)');
  });
});
