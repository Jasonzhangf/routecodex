#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectAdmissionFailures } from '../../scripts/architecture/verify-admission.mjs';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = path.join(v3Root, 'build-contracts', 'architecture-admission');
const scratchRoot = path.join(v3Root, 'build-control', 'admission-red');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function copyAdmission(name) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const target = fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
  fs.cpSync(sourceRoot, target, { recursive: true });
  return target;
}

function rewriteManifest(root, mutate) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  const payload = {
    schema_version: manifest.schema_version,
    generator: manifest.generator,
    output_root: manifest.output_root,
    files: manifest.files,
  };
  manifest.manifest_digest = sha256(canonicalJson(payload));
  fs.writeFileSync(manifestPath, canonicalJson(manifest));
}

assert.deepEqual(collectAdmissionFailures({ root: sourceRoot }), []);

const missingManifest = copyAdmission('missing-manifest');
fs.rmSync(path.join(missingManifest, 'manifest.json'));
assert(collectAdmissionFailures({ root: missingManifest }).some((failure) => failure.includes('missing')));

const malformedManifest = copyAdmission('malformed-manifest');
fs.writeFileSync(path.join(malformedManifest, 'manifest.json'), '{');
assert(collectAdmissionFailures({ root: malformedManifest }).some((failure) => failure.includes('invalid')));

const tamperedManifest = copyAdmission('tampered-manifest');
const tampered = JSON.parse(fs.readFileSync(path.join(tamperedManifest, 'manifest.json'), 'utf8'));
tampered.generator = 'unregistered-generator';
fs.writeFileSync(path.join(tamperedManifest, 'manifest.json'), canonicalJson(tampered));
assert(collectAdmissionFailures({ root: tamperedManifest }).some((failure) => failure.includes('manifest digest mismatch')));

const missingFile = copyAdmission('missing-file');
fs.rmSync(path.join(missingFile, 'repo', 'docs', 'architecture', 'v3-function-map.yml'));
assert(collectAdmissionFailures({ root: missingFile }).some((failure) => failure.includes('missing')));

const tamperedFile = copyAdmission('tampered-file');
fs.appendFileSync(path.join(tamperedFile, 'repo', 'docs', 'architecture', 'v3-function-map.yml'), '\n# tampered\n');
assert(collectAdmissionFailures({ root: tamperedFile }).some((failure) => failure.includes('file digest mismatch')));

const wrongSource = copyAdmission('wrong-source');
rewriteManifest(wrongSource, (manifest) => {
  manifest.files[0].source_path = 'docs/architecture/not-canonical.yml';
});
assert(collectAdmissionFailures({ root: wrongSource }).some((failure) => failure.includes('source binding mismatch')));

const invalidCommit = copyAdmission('invalid-commit');
rewriteManifest(invalidCommit, (manifest) => {
  manifest.files[0].source_commit = 'pending';
});
assert(collectAdmissionFailures({ root: invalidCommit }).some((failure) => failure.includes('source commit invalid')));

fs.rmSync(scratchRoot, { recursive: true, force: true });
process.stdout.write('[test:v3-architecture-admission-red-fixtures] PASS\n');
