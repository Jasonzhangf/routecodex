import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..', '..', '..', '..');

const TARGETS: ReadonlyArray<string> = [
  'src/server/runtime/http-server/http-server-runtime-providers.ts',
  'src/server/runtime/http-server/request-executor.ts',
  'src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts',
];

// Patterns that the Phase 3 abstraction must eliminate from the listed
// server-runtime files. Provider-specific strings belong in provider runtime,
// not in the executor / server-runtime providers bootstrap path.
const FORBIDDEN_SUBSTRINGS: ReadonlyArray<string> = [
  'provider-specific-runtime-prefix.',
];

const TEST_FILES: ReadonlyArray<string> = [
  'src/providers/core/contracts/deepseek-provider-contract.ts',
];

// Provider contracts are allowed to mention provider-specific identifiers.
// We only assert that the executor / http-server-runtime-providers files do not.
const ALLOWED_FILES: ReadonlyArray<string> = TEST_FILES;

function isAllowed(file: string): boolean {
  return ALLOWED_FILES.includes(file);
}

describe('phase 3: providerFamily abstraction — no provider-specific string prefix in server runtime', () => {
  for (const file of TARGETS) {
    it(`${file} contains zero provider-specific runtime prefix string literals`, () => {
      const fullPath = resolve(REPO, file);
      const source = readFileSync(fullPath, 'utf8');
      const findings: Array<{ token: string; line: number; snippet: string }> = [];
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        // strip line comments and block comments crudely
        const stripped = raw.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const token of FORBIDDEN_SUBSTRINGS) {
          if (stripped.includes(token)) {
            findings.push({ token, line: i + 1, snippet: raw.trim().slice(0, 160) });
          }
        }
      }
      expect(findings).toEqual([]);
    });
  }

  it('allowed files are not asserted against (sanity)', () => {
    for (const file of ALLOWED_FILES) {
      // Just ensure they still exist on disk.
      const fullPath = resolve(REPO, file);
      expect(() => readFileSync(fullPath, 'utf8')).not.toThrow();
    }
  });

  it('test file itself is exempt from the provider-specific literal scan', () => {
    const selfPath = __filename;
    const source = readFileSync(selfPath, 'utf8');
    // This test legitimately references the forbidden tokens in strings, so
    // assert that we are not also accidentally checking ourselves.
    expect(isAllowed('tests/.../phase3-provider-family-abstraction.red.spec.ts')).toBe(false);
    expect(source).toContain('provider-specific-runtime-prefix.');
  });
});
