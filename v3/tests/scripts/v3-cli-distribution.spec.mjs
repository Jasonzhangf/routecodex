import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(v3Root, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));

test('V3 package declares the public command aliases', () => {
  assert.deepEqual(packageJson.bin, {
    routecodex: 'dist/bin/rccv3',
    rcc: 'dist/bin/rccv3',
    rccv3: 'dist/bin/rccv3',
  });
});

test('unsupported pack mode fails before creating V3 staging or mutating version truth', () => {
  const packageBefore = read('package.json');
  const buildControl = path.join(v3Root, 'build-control', 'pack');
  const entriesBefore = fs.existsSync(buildControl) ? fs.readdirSync(buildControl).sort() : [];
  const result = spawnSync(process.execPath, ['scripts/pack-release.mjs', '--mode', 'invalid'], {
    cwd: v3Root,
    encoding: 'utf8',
  });
  const entriesAfter = fs.existsSync(buildControl) ? fs.readdirSync(buildControl).sort() : [];
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[pack-release\] unknown mode:/);
  assert.equal(read('package.json'), packageBefore);
  assert.deepEqual(entriesAfter, entriesBefore);
});
