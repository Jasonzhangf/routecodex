import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requiredFiles = [
  'docs/architecture/README.md',
  'docs/architecture/function-map.yml',
  'docs/architecture/verification-map.yml',
];

const failures = [];

for (const rel of requiredFiles) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    failures.push(`missing file: ${rel}`);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8').trim();
  if (!text) failures.push(`empty file: ${rel}`);
}

const functionMap = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');
if (!functionMap.includes('feature_id:')) failures.push('function-map missing feature_id field');
if (!functionMap.includes('owner_module:')) failures.push('function-map missing owner_module field');
if (!functionMap.includes('required_tests:')) failures.push('function-map missing required_tests field');

const verificationMap = fs.readFileSync(path.join(root, 'docs/architecture/verification-map.yml'), 'utf8');
if (!verificationMap.includes('feature_id:')) failures.push('verification-map missing feature_id field');
if (!verificationMap.includes('smoke:')) failures.push('verification-map missing smoke field');
if (!verificationMap.includes('build:')) failures.push('verification-map missing build field');

if (failures.length > 0) {
  console.error('[verify:architecture] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture] ok');
console.log(`- checked ${requiredFiles.length} required template files`);
console.log('- checked minimal function-map fields');
console.log('- checked minimal verification-map fields');
