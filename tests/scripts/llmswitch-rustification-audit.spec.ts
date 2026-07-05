import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from '@jest/globals';

const REPO_ROOT = '/Users/fanzhang/Documents/github/routecodex';
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/ci/llmswitch-rustification-audit.mjs');

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

function runGit(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

describe('llmswitch rustification audit source/doc-only discovery', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('counts only git-tracked source TS and excludes generated artifacts', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-rustification-audit-'));
    runGit(tempRoot, ['init']);
    runGit(tempRoot, ['config', 'user.email', 'audit@example.invalid']);
    runGit(tempRoot, ['config', 'user.name', 'Rustification Audit Test']);

    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/runtime/native-linked.ts',
      "import { loadNativeRouterHotpathBinding } from './native-router-hotpath';\nexport const nativeLinked = loadNativeRouterHotpathBinding;\n",
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/runtime/non-native.ts',
      'export const semanticDebt = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/runtime/untracked.ts',
      'export const mustNotCount = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/dist/generated.ts',
      'export const generatedDist = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/.mempalace/indexed.ts',
      'export const indexedMemory = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/.local-index/indexed.ts',
      'export const localIndex = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/runtime/generated-report.ts',
      'export const generatedReport = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/runtime/deleted-tracked.ts',
      'export const deletedTracked = true;\n',
    );
    await writeFile(
      tempRoot,
      'sharedmodule/llmswitch-core/src/runtime/old.backup',
      'export const backup = true;\n',
    );
    await writeFile(
      tempRoot,
      'docs/architecture/wiki/html/generated.html',
      '<html></html>\n',
    );

    runGit(tempRoot, [
      'add',
      'sharedmodule/llmswitch-core/src/runtime/native-linked.ts',
      'sharedmodule/llmswitch-core/src/runtime/non-native.ts',
      'sharedmodule/llmswitch-core/src/dist/generated.ts',
      'sharedmodule/llmswitch-core/src/.mempalace/indexed.ts',
      'sharedmodule/llmswitch-core/src/.local-index/indexed.ts',
      'sharedmodule/llmswitch-core/src/runtime/generated-report.ts',
      'sharedmodule/llmswitch-core/src/runtime/deleted-tracked.ts',
      'sharedmodule/llmswitch-core/src/runtime/old.backup',
      'docs/architecture/wiki/html/generated.html',
    ]);
    runGit(tempRoot, ['commit', '-m', 'seed audit fixture']);
    await fs.rm(path.join(tempRoot, 'sharedmodule/llmswitch-core/src/runtime/deleted-tracked.ts'));

    const baselineRaw = execFileSync('node', [SCRIPT_PATH, '--write-baseline', '--json'], {
      cwd: tempRoot,
      encoding: 'utf8',
    });
    const baseline = JSON.parse(baselineRaw) as {
      metrics: {
        prodTsFileCount: number;
        nonNativeFileCount: number;
      };
    };

    expect(baseline.metrics.prodTsFileCount).toBe(2);
    expect(baseline.metrics.nonNativeFileCount).toBe(1);

    const compareRaw = execFileSync('node', [SCRIPT_PATH, '--json'], {
      cwd: tempRoot,
      encoding: 'utf8',
    });
    const compare = JSON.parse(compareRaw) as {
      metrics: {
        prodTsFileCount: number;
        nonNativeFileCount: number;
      };
      result: { ok: boolean; newProdTsFiles: string[] };
    };

    expect(compare.metrics.prodTsFileCount).toBe(2);
    expect(compare.metrics.nonNativeFileCount).toBe(1);
    expect(compare.result.ok).toBe(true);
    expect(compare.result.newProdTsFiles).toEqual([]);
  });
});
