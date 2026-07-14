import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const scriptPath = path.resolve(process.cwd(), 'scripts/architecture/generate-mainline-chain-manifests.mjs');

describe('feature_id: architecture.mainline_chain_manifest_payload_copy_budget', () => {
  test('mainline manifest generator owns one manifest object without JSON round-trip cloning', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain('buildMainlineChainManifest');
    expect(source).not.toContain('JSON.parse(JSON.stringify(manifest))');
    expect(source).not.toContain('manifestClean');
  });

  test('builder creates the expected manifest shape without running file IO on import', async () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `
        const mod = await import(${JSON.stringify(pathToFileURL(scriptPath).href)});
        const manifest = mod.buildMainlineChainManifest({
          chain_id: 'request.mainline',
          summary: 'request chain',
          edges: [
            { step_id: 'r1', from_node: 'A', to_node: 'B', owner_feature_id: 'owner.one' },
            { step_id: 'r2', from_node: 'B', to_node: 'C', owner_feature_id: 'owner.one', binding_pending: true, split_binding_id: 'split-1' },
          ],
        });
        console.log(JSON.stringify(manifest));
      `,
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const manifest = JSON.parse(result.stdout);

    expect(manifest).toMatchObject({
      lifecycle_id: 'request.mainline',
      summary: 'request chain',
      owner_feature_id: 'owner.one',
      entrypoint: {
        node_id: 'A',
        wiki_page: 'docs/architecture/wiki/mainline-call-graph.md',
        call_map_chain_id: 'request.mainline',
      },
      node_ids: ['A', 'B', 'C'],
    });
    expect(manifest.edges).toEqual([
      {
        step_id: 'r1',
        from_node: 'A',
        to_node: 'B',
        status: 'anchored',
        owner_feature_id: 'owner.one',
        binding_pending: null,
        split_binding_id: null,
      },
      {
        step_id: 'r2',
        from_node: 'B',
        to_node: 'C',
        status: 'binding pending',
        owner_feature_id: 'owner.one',
        binding_pending: true,
        split_binding_id: 'split-1',
      },
    ]);
  });
});
