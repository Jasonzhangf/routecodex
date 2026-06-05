import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const functionMapPath = path.join(root, 'docs/architecture/function-map.yml');
const verificationMapPath = path.join(root, 'docs/architecture/verification-map.yml');

const functionMap = fs.readFileSync(functionMapPath, 'utf8');
const verificationMap = fs.readFileSync(verificationMapPath, 'utf8');
const failures = [];

if (functionMap.includes('feature_id: example.')) {
  failures.push('function-map still contains example template feature_id');
}
if (verificationMap.includes('feature_id: example.')) {
  failures.push('verification-map still contains example template feature_id');
}

const featureIds = [...functionMap.matchAll(/feature_id:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
const verificationIds = new Set(
  [...verificationMap.matchAll(/feature_id:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1])
);

if (featureIds.length < 4) {
  failures.push(`expected at least 4 active feature rows, got ${featureIds.length}`);
}

for (const id of featureIds) {
  if (!verificationIds.has(id)) failures.push(`missing verification map entry for ${id}`);
}

if (!functionMap.includes('status: active')) {
  failures.push('function-map has no active feature rows');
}

if (failures.length > 0) {
  console.error('[verify:function-map-coverage] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:function-map-coverage] ok');
console.log(`- active features: ${featureIds.length}`);
console.log('- every function-map feature has verification-map coverage');
