#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message) {
  throw new Error(message);
}

function buildPatch(lines) {
  return `${lines.join('\n')}\n`;
}

function runApplyPatch(cwd, patchText) {
  const which = spawnSync('bash', ['-lc', 'command -v apply_patch'], {
    encoding: 'utf-8'
  });
  if (which.status !== 0 || !which.stdout.trim()) {
    fail('apply_patch binary not found in PATH');
  }
  const result = spawnSync(which.stdout.trim(), [], {
    cwd,
    input: patchText,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    fail(`apply_patch spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `apply_patch exited ${result.status}\nstdout=${result.stdout || ''}\nstderr=${result.stderr || ''}`
    );
  }
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

async function readFile(root, rel) {
  return fs.readFile(path.join(root, rel), 'utf-8');
}

async function exists(root, rel) {
  try {
    await fs.access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function withScenario(name, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `routecodex-apply-patch-${name}-`));
  try {
    await fn(root);
    console.log(`✅ ${name}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await withScenario('add-file', async (root) => {
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Add File: added.txt',
      '+hello',
      '+world',
      '*** End Patch'
    ])
  );
  assert.equal(await readFile(root, 'added.txt'), 'hello\nworld\n');
});

await withScenario('update-file-simple', async (root) => {
  await writeFile(root, 'simple.txt', 'line1\nline2\nline3\n');
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Update File: simple.txt',
      '@@',
      ' line1',
      '-line2',
      '+line2-updated',
      ' line3',
      '*** End Patch'
    ])
  );
  assert.equal(await readFile(root, 'simple.txt'), 'line1\nline2-updated\nline3\n');
});

await withScenario('update-file-multi-hunk', async (root) => {
  await writeFile(root, 'multi.txt', 'a\nb\nc\nd\ne\n');
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Update File: multi.txt',
      '@@',
      ' a',
      '-b',
      '+b2',
      ' c',
      ' d',
      '-e',
      '+e2',
      '*** End Patch'
    ])
  );
  assert.equal(await readFile(root, 'multi.txt'), 'a\nb2\nc\nd\ne2\n');
});

await withScenario('update-file-boundary-lines', async (root) => {
  await writeFile(root, 'boundary.txt', 'first\nmiddle\nlast\n');
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Update File: boundary.txt',
      '@@',
      '-first',
      '+first-new',
      ' middle',
      ' last',
      '*** End Patch'
    ])
  );
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Update File: boundary.txt',
      '@@',
      ' first-new',
      ' middle',
      '-last',
      '+last-new',
      '*** End Patch'
    ])
  );
  assert.equal(await readFile(root, 'boundary.txt'), 'first-new\nmiddle\nlast-new\n');
});

await withScenario('update-empty-file', async (root) => {
  await writeFile(root, 'empty.txt', '');
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Update File: empty.txt',
      '@@',
      '+seed line',
      '*** End Patch'
    ])
  );
  assert.equal(await readFile(root, 'empty.txt'), 'seed line\n');
});

await withScenario('delete-file', async (root) => {
  await writeFile(root, 'delete-me.txt', 'bye\n');
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Delete File: delete-me.txt',
      '*** End Patch'
    ])
  );
  assert.equal(await exists(root, 'delete-me.txt'), false);
});

await withScenario('mixed-add-update-delete', async (root) => {
  await writeFile(root, 'original.txt', 'alpha\nbeta\ngamma\n');
  await writeFile(root, 'remove.txt', 'remove\n');
  runApplyPatch(
    root,
    buildPatch([
      '*** Begin Patch',
      '*** Add File: created.txt',
      '+created-1',
      '+created-2',
      '*** Update File: original.txt',
      '@@',
      ' alpha',
      '-beta',
      '+beta-updated',
      ' gamma',
      '*** Delete File: remove.txt',
      '*** End Patch'
    ])
  );
  assert.equal(await readFile(root, 'created.txt'), 'created-1\ncreated-2\n');
  assert.equal(await readFile(root, 'original.txt'), 'alpha\nbeta-updated\ngamma\n');
  assert.equal(await exists(root, 'remove.txt'), false);
});

console.log('✅ all apply_patch standard scenarios passed');
