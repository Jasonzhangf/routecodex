import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

describe('llms-engine shadow payload copy budget', () => {
  it('ignores configured compare paths without cloning or mutating the debug payloads', async () => {
    const { recordLlmsEngineShadowDiff } = await import('../../src/utils/llms-engine-shadow.ts');
    const baselineOut: Record<string, unknown> = {
      providerPayload: {
        requestId: 'baseline-only',
        nested: {
          bigint: BigInt(1)
        }
      }
    };
    const candidateOut: Record<string, unknown> = {
      providerPayload: {
        requestId: 'candidate-only',
        nested: {
          bigint: BigInt(1)
        }
      }
    };

    await recordLlmsEngineShadowDiff({
      group: 'hub-pipeline',
      requestId: 'req-shadow-copy-budget',
      subpath: 'copy-budget',
      baselineImpl: 'ts',
      candidateImpl: 'engine',
      baselineOut,
      candidateOut,
      excludedComparePaths: ['providerPayload.requestId']
    });

    expect((baselineOut.providerPayload as Record<string, unknown>).requestId).toBe('baseline-only');
    expect((candidateOut.providerPayload as Record<string, unknown>).requestId).toBe('candidate-only');
  });

  it('writes the same full debug artifact while excluding only configured diff paths', async () => {
    const previousDir = process.env.ROUTECODEX_LLMS_SHADOW_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-shadow-copy-budget-'));
    process.env.ROUTECODEX_LLMS_SHADOW_DIR = root;
    try {
      const { recordLlmsEngineShadowDiff } = await import('../../src/utils/llms-engine-shadow.ts');
      const baselineOut = {
        providerPayload: {
          requestId: 'baseline-id',
          result: 1
        }
      };
      const candidateOut = {
        providerPayload: {
          requestId: 'candidate-id',
          result: 2
        }
      };

      await recordLlmsEngineShadowDiff({
        group: 'provider-response',
        requestId: 'req-shadow-artifact',
        subpath: 'copy-budget-positive',
        baselineImpl: 'ts',
        candidateImpl: 'engine',
        baselineOut,
        candidateOut,
        excludedComparePaths: ['providerPayload.requestId']
      });

      const artifactDir = path.join(root, 'provider-response', 'copy-budget-positive');
      const artifacts = fs.readdirSync(artifactDir);
      expect(artifacts).toHaveLength(1);
      const artifact = JSON.parse(
        fs.readFileSync(path.join(artifactDir, artifacts[0]!), 'utf8')
      ) as Record<string, unknown>;
      expect(artifact).toMatchObject({
        diffCount: 1,
        diffPaths: ['providerPayload.result'],
        baselineOut,
        candidateOut
      });
    } finally {
      if (previousDir === undefined) {
        delete process.env.ROUTECODEX_LLMS_SHADOW_DIR;
      } else {
        process.env.ROUTECODEX_LLMS_SHADOW_DIR = previousDir;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reintroduce JSON round-trip compare-path cloning', () => {
    for (const relative of [
      'src/utils/llms-engine-shadow.ts',
      'src/utils/llms-engine-shadow.js'
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
      expect(source).not.toContain('cloneJsonSafe');
      expect(source).not.toContain('JSON.parse(JSON.stringify');
    }
  });
});
