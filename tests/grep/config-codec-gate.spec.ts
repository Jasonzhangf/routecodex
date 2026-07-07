/**
 * Grep gate test: prevent scattered JSON.parse/readFile for config files
 * outside the designated codec SSOT (user-config-codec, provider-config-codec).
 *
 * This test fails if any production source file directly parses config.json/v2.json
 * without going through the codec functions (parseUserConfigText, parseProviderConfigText).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Files that are allowed to do raw config file I/O (the codec SSOT)
const CODEC_SSOT_FILES = new Set([
  'src/config/toml-basic.ts',
  'src/config/user-config-codec.ts',
  'src/config/provider-config-codec.ts',
  'src/config/routecodex-config-loader.ts',
  'src/config/user-config-loader.ts',
  'src/config/provider-v2-loader.ts',
  'src/config/unified-config-paths.ts',
  'src/config/user-data-paths.ts',
  'src/config/config-paths.ts',
  'src/config/config-migration.ts',
  'src/config/user-config-writer.ts',
  'src/config/provider-config-writer.ts',
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

function runGrep(command: string, cwd: string): string {
  try {
    return execSync(command, { cwd, encoding: 'utf8' });
  } catch (e: any) {
    if (e.status !== 1) {
      throw e;
    }
    return '';
  }
}

describe('Config Codec Gate', () => {
  let grepOutput: string = '';
  const testDir = path.dirname(fileURLToPath(import.meta.url));

  beforeAll(() => {
    const rootDir = path.resolve(testDir, '..', '..');
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
    const rootDir = path.resolve(testDir, '..', '..');
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
            !filePath.includes('user-config-codec')) {
          writeViolations.push(line);
        }
      }
    }
    expect(writeViolations).toEqual([]);
  });

  test('legacy JSON config runtime entrypoints stay removed from production source', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' --include='*.js' -E ` +
      `'config\\.v1\\.json|config\\.v2\\.json|config\\.json|migrate-user-config|config-migration-json-to-toml|user-config-migration|virtual-router-shadow-v2' ` +
      `src sharedmodule/llmswitch-core/src ` +
      `| grep -v 'node_modules' ` +
      `| grep -v 'config JSON support removed' ` +
      `| grep -v 'provider config JSON support removed'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('v1 virtualrouter.providers production access is limited to Rust materialization output validation', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' --include='*.js' -E 'virtualrouter\\.providers' src sharedmodule/llmswitch-core/src ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    const violations = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes('src/config/user-config-loader.ts'));
    expect(violations).toEqual([]);
  });

  test('old TypeScript config materialization helpers stay deleted', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E ` +
      `'extractRoutingFromUserConfig|extractPolicyGroupOptionFromUserConfig|resolveReferencedProviderIdsFromRouting|resolveReferencedForwarderIdsFromRouting|resolveProviderIdsFromProviderPorts|extractApplyPatchConfigFromUserConfig|extractForwardersFromUserConfig|normalizeForwardersForNative|resolveForwarderTargetProviderKeys|providerAuthAliases|providerDeclaresModel|withRoutePolicyGroupTag|parseProviderIdFromProviderKeyForConfig|pickNumber' ` +
      `src/config src/server src/modules sharedmodule/llmswitch-core/src ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('user config loader does not locally rebuild materialized virtualrouter output', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E ` +
      `'userConfig\\.virtualrouter\\s*=|providers:\\s*v2Input\\.providers|routing:\\s*v2Input\\.routing|forwarders:\\s*v2Input\\.forwarders|applyPatch:\\s*v2Input\\.applyPatch' ` +
      `src/config/user-config-loader.ts ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('provider profile projection semantics stay out of TypeScript shell', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E ` +
      `'function resolveProtocol|const protocolAliases|function extractTransport|function extractHeaders|function extractAuth|function normalizeAuthType|function extractCompatProfile|function extractMetadata|function collectProviderNodes' ` +
      `src/providers/profile/provider-profile-loader.ts src/config ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('provider v2 root loading semantics stay out of TypeScript shell', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E ` +
      `'fs/promises|readdir|readFile|function listProviderDirs|function listProviderConfigFiles|function loadProviderConfigV2|decodeProviderConfigFile|coerceProviderConfigV2FromParsed|planRouteCodexProviderConfigV2FilesSync|resolveRouteCodexProviderConfigV2IdentitySync|duplicate providerId' ` +
      `src/config/provider-v2-loader.ts ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('provider id CLI/admin/init config reads go through provider v2 root loader', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E 'decodeProviderConfigFile|decodeProviderConfigFileSync|coerceProviderConfigV2FromParsed|planRouteCodexProviderConfigV2FilesSync|resolveRouteCodexProviderConfigV2IdentitySync|getProviderRootDir|getProviderConfigOutputPath|writeJsonFile|config\\.v2\\.json|provider/\\*\\.json' ` +
      `src/commands/provider-update.ts src/commands/provider-update-maintenance.ts src/tools/provider-update/index.ts ` +
      `src/server/handlers/config-admin-handler.ts src/server/runtime/http-server/daemon-admin/providers-handler.ts ` +
      `src/cli/commands/init.ts src/cli/commands/init/basic.ts src/cli/commands/init/workflows.ts ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('forwarder profile projection semantics stay out of TypeScript shell', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E ` +
      `'function collectForwarderNodes|function parseForwarderTargets|function parseForwarderWeights|function pickPositiveInt|function pickNumber|function pickString|transportOverride is not supported|has invalid resolutionMode|has invalid stickyKey|references unknown providerId' ` +
      `src/providers/profile/provider-profile-loader.ts src/config ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('server runtime consumes full Rust config manifest instead of VR-only bootstrap input', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E 'compileRouteCodexVirtualRouterBootstrapInput|buildVirtualRouterInputV2' src/server/runtime/http-server src/config/user-config-loader.ts ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('server runtime routing allowlist and tiers come from Rust pipelineRuntimeConfig artifacts', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const output = runGrep(
      `grep -rn --include='*.ts' -E ` +
      `'extractProviderKeysForRoutingGroup|extractRoutingTiersForRoutingGroupRoute|user config 缺少 virtualrouter\\.routing|Virtual router routes|Provider targets|routingProviderIds.*virtualrouter|routingTiersByRoute.*virtualrouter' ` +
      `src/server/runtime/http-server src/index.ts ` +
      `| grep -v 'node_modules'`,
      rootDir
    );
    expect(output.trim()).toBe('');
  });

  test('remaining src/config TypeScript files are explicitly classified', () => {
    const rootDir = path.resolve(testDir, '..', '..');
    const tracked = runGrep(
      `git ls-files 'src/config/*.ts' 'src/config/*.d.ts'`,
      rootDir
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    const manifestPath = path.join(rootDir, 'docs/loops/rustification/config-ts-surface.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      entries?: Array<{
        path?: string;
        classification?: string;
        ownerFeature?: string;
        removableNow?: boolean;
        cannotShrinkFurtherBecause?: string;
      }>;
    };
    const entries = new Map((manifest.entries ?? []).map((entry) => [entry.path, entry]));
    const missing = tracked.filter((filePath) => !entries.has(filePath));
    const stale = [...entries.keys()]
      .filter((filePath): filePath is string => typeof filePath === 'string' && !tracked.includes(filePath))
      .sort();
    const weak = [...entries.values()].filter((entry) => {
      return !entry.classification
        || !entry.ownerFeature
        || entry.removableNow !== false
        || typeof entry.cannotShrinkFurtherBecause !== 'string'
        || entry.cannotShrinkFurtherBecause.trim().length < 40;
    });
    expect({ missing, stale, weak }).toEqual({ missing: [], stale: [], weak: [] });
  });
});
