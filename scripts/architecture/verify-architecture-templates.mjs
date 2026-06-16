import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requiredFiles = [
  'docs/architecture/README.md',
  'docs/architecture/function-map.yml',
  'docs/architecture/mainline-call-map.yml',
  'docs/architecture/verification-map.yml',
  'docs/architecture/wiki/README.md',
  'docs/architecture/wiki/mainline-call-graph.md',
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

const mainlineCallMap = fs.readFileSync(path.join(root, 'docs/architecture/mainline-call-map.yml'), 'utf8');
if (!mainlineCallMap.includes('chain_id:')) failures.push('mainline-call-map missing chain_id field');
if (!mainlineCallMap.includes('from_node:')) failures.push('mainline-call-map missing from_node field');
if (!mainlineCallMap.includes('to_node:')) failures.push('mainline-call-map missing to_node field');

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
console.log('- checked minimal mainline-call-map fields');
console.log('- checked minimal verification-map fields');
