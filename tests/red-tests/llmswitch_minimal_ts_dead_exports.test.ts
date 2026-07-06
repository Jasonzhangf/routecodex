import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const MANIFEST_PATH = 'docs/loops/rustification/minimal-ts-surface.json';
const SEARCH_ROOTS = [
  'sharedmodule/llmswitch-core/src',
  'src',
  'scripts',
];

const allowedPublicSurfaceExports: Record<string, readonly string[]> = {
  'sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.ts': [
    'ContextWeightedLoadBalancingConfig',
    'DeepSeekCompatRuntimeOptions',
    'FeatureBuilder',
    'ForwarderStatusState',
    'ForwarderTargetStatusState',
    'HealthWeightedLoadBalancingConfig',
    'LoadBalancingPolicy',
    'ProviderCooldownState',
    'ProviderHealthConfig',
    'ProviderHealthState',
    'ProviderRuntimeMap',
    'RoutePoolLoadBalancingPolicy',
    'RoutePoolMode',
    'RoutePoolTier',
    'VirtualRouterApplyPatchConfig',
    'VirtualRouterClassifierConfig',
    'VirtualRouterClockConfig',
    'VirtualRouterExecCommandGuardConfig',
    'VirtualRouterProviderDefinition',
    'VirtualRouterRoutePoolStatus',
    'VirtualRouterWebSearchConfig',
    'VirtualRouterWebSearchDirectActivation',
    'VirtualRouterWebSearchEngineConfig',
    'VirtualRouterWebSearchExecutionMode',
  ],
  'sharedmodule/llmswitch-core/src/telemetry/stats-center.ts': [
    'ProviderStatsSnapshot',
    'ProviderStatsBucket',
    'RouterStatsBucket',
    'RouterStatsSnapshot',
    'StatsCenterOptions',
    'initStatsCenter',
  ],
};

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function extractDeclaredExports(source: string): string[] {
  const matches = source.matchAll(
    /^export\s+(?:declare\s+)?(?:type\s+)?(?:interface|type|class|function|const|let|var|enum)\s+([A-Za-z0-9_]+)/gm,
  );
  return Array.from(matches, (match) => match[1]).filter(Boolean);
}

function hasExternalSourceConsumer(filePath: string, symbol: string): boolean {
  const result = spawnSync(
    'rg',
    [
      '-n',
      '--fixed-strings',
      symbol,
      ...SEARCH_ROOTS,
      '--glob',
      '!dist/**',
      '--glob',
      '!target/**',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!coverage/**',
      '--glob',
      '!**/*.test.ts',
      '--glob',
      '!**/*.spec.ts',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );

  const lines = (result.stdout || '').split('\n').filter(Boolean);
  return lines.some((line) => !line.startsWith(`${filePath}:`));
}

describe('llmswitch minimal TS dead export boundary', () => {
  it('does not grow unconsumed TS facade exports outside explicit public surfaces', () => {
    const manifest = JSON.parse(read(MANIFEST_PATH)) as {
      entries?: Array<{ path?: string }>;
    };
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const unexpected: string[] = [];

    for (const entry of entries) {
      if (!entry.path) continue;
      const source = read(entry.path);
      const allowed = new Set(allowedPublicSurfaceExports[entry.path] || []);
      for (const symbol of extractDeclaredExports(source)) {
        if (hasExternalSourceConsumer(entry.path, symbol)) continue;
        if (allowed.has(symbol)) continue;
        unexpected.push(`${entry.path}#${symbol}`);
      }
    }

    expect(unexpected).toEqual([]);
  });
});
