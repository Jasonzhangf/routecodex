#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'target/release/rccv4');
const directory = path.join(os.homedir(), '.local/bin');
const destination = path.join(directory, 'rccv4');
const temporary = path.join(directory, `.rccv4.${process.pid}.installing`);

if (!fs.existsSync(source)) {
  throw new Error(`release binary missing: ${source}`);
}
fs.mkdirSync(directory, { recursive: true });
fs.copyFileSync(source, temporary);
fs.chmodSync(temporary, 0o755);

const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', temporary], {
  encoding: 'utf8',
});
if (sign.status !== 0) {
  throw new Error(`codesign failed: ${sign.stderr || sign.stdout}`);
}
const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', temporary], {
  encoding: 'utf8',
});
if (verify.status !== 0) {
  throw new Error(`codesign verify failed: ${verify.stderr || verify.stdout}`);
}

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stagedDigest = digest(temporary);
fs.renameSync(temporary, destination);
const installedDigest = digest(destination);
if (stagedDigest !== installedDigest) {
  throw new Error(`installed hash drift: staged=${stagedDigest} installed=${installedDigest}`);
}
console.log(`installed ${destination} sha256=${installedDigest} codesign=valid`);
