import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const hook of ['pre-commit', 'pre-push']) {
  test(`${hook} isolates Git environment before subtree verification`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-hook-'));
    try {
      const cleanEnv = { ...process.env };
      const names = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
      assert.equal(names.status, 0);
      for (const name of names.stdout.trim().split('\n')) delete cleanEnv[name];
      const init = spawnSync('git', ['init', '-b', 'test-owner', root], { env: cleanEnv });
      assert.equal(init.status, 0);
      fs.mkdirSync(path.join(root, 'v4/.githooks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'bin'));
      fs.copyFileSync(new URL(`../.githooks/${hook}`, import.meta.url), path.join(root, 'v4/.githooks', hook));
      // The verification launcher probes repository discovery instead of running the full matrix.
      fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\ngit rev-parse --show-toplevel\n', { mode: 0o755 });
      const result = spawnSync('sh', [path.join(root, 'v4/.githooks', hook)], {
        cwd: root, encoding: 'utf8', input: '',
        env: { ...cleanEnv, PATH: `${root}/bin:${process.env.PATH}`, GIT_DIR: `${root}/.git`, GIT_WORK_TREE: '.' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
