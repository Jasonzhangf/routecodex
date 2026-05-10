/**
 * Grep gate test: prevent scattered JSON.parse/readFile for config files
 * outside the designated codec SSOT (user-config-codec, provider-config-codec).
 *
 * This test fails if any production source file directly parses config.json/v2.json
 * without going through the codec functions (parseUserConfigText, parseProviderConfigText).
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

// Files that are allowed to do raw config file I/O (the codec SSOT)
const CODEC_SSOT_FILES = new Set([
  'src/config/toml-basic.ts',
  'src/config/user-config-codec.ts',
  'src/config/provider-config-codec.ts',
  'src/config/toml-commented-template.ts',
  'src/config/routecodex-config-loader.ts',
  'src/config/user-config-loader.ts',
  'src/config/provider-v2-loader.ts',
  'src/config/unified-config-paths.ts',
  'src/config/user-data-paths.ts',
  'src/config/config-paths.ts',
  'src/config/config-migration.ts',
  'src/config/config-semantic-compare.ts',
]);

// Config-related filenames that trigger the gate
const CONFIG_FILENAME_PATTERNS = [
  'config.json',
  'config.toml',
  'config.v2.json',
  'config.v2.toml',
  'routecodex.json',
];

function isSsoTFile(filePath: string): boolean {
  for (const allowed of CODEC_SSOT_FILES) {
    if (filePath.endsWith(allowed)) return true;
  }
  return false;
}

describe('Config Codec Gate', () => {
  let grepOutput: string = '';

  beforeAll(() => {
    const rootDir = path.resolve(__dirname, '..', '..');
    try {
      grepOutput = execSync(
        `grep -rn --include='*.ts' -E 'JSON\\.parse.*(readFile|readFileSync)|readFileSync.*config|readFile.*config' src/ ` +
        `| grep -iE 'config\\.(json|toml|v2)' ` +
        `| grep -v 'node_modules' ` +
        `| grep -v '\\.spec\\.ts' ` +
        `| grep -v '\\.test\\.ts' ` +
        `| grep -v '__tests__'`,
        { cwd: rootDir, encoding: 'utf8' }
      );
    } catch (e: any) {
      // grep returns non-zero if no matches, which is good (empty output)
      if (e.status !== 1) {
        throw e;
      }
      grepOutput = '';
    }
  });

  test('no scattered JSON config reads outside codec SSOT', () => {
    const violations: string[] = [];
    if (grepOutput.trim()) {
      const lines = grepOutput.trim().split('\n');
      for (const line of lines) {
        const filePath = line.split(':')[0] || '';
        if (!isSsoTFile(filePath)) {
          violations.push(line);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('no raw JSON.stringify write for config files outside codec SSOT', () => {
    const rootDir = path.resolve(__dirname, '..', '..');
    let writeGrep = '';
    try {
      writeGrep = execSync(
        `grep -rn --include='*.ts' -E 'writeFile.*config\\.(json|toml|v2)|JSON\\.stringify.*payload.*config' src/ ` +
        `| grep -v 'node_modules' ` +
        `| grep -v '\\.spec\\.ts' ` +
        `| grep -v '\\.test\\.ts' ` +
        `| grep -v '__tests__' ` +
        `| grep -v 'provider-update-shared' ` +
        `| grep -v 'serializeTomlRecord' ` +
        `| grep -v 'codec'`,
        { cwd: rootDir, encoding: 'utf8' }
      );
    } catch (e: any) {
      if (e.status !== 1) throw e;
      writeGrep = '';
    }

    const writeViolations: string[] = [];
    if (writeGrep.trim()) {
      const lines = writeGrep.trim().split('\n');
      for (const line of lines) {
        const filePath = line.split(':')[0] || '';
        if (!isSsoTFile(filePath) &&
            !filePath.includes('toml-comment-preserving') &&
            !filePath.includes('provider-config-codec') &&
            !filePath.includes('user-config-codec') &&
            !filePath.includes('config-builder')) {
          writeViolations.push(line);
        }
      }
    }
    expect(writeViolations).toEqual([]);
  });
});
