import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const functionMapPath = path.join(root, 'docs/architecture/function-map.yml');
const verificationMapPath = path.join(root, 'docs/architecture/verification-map.yml');
const functionMap = fs.readFileSync(functionMapPath, 'utf8');
const verificationMap = fs.readFileSync(verificationMapPath, 'utf8');

const sourceRoots = ['sharedmodule', 'src'];
const exts = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs']);

function listFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!fs.existsSync(absRoot)) return [];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'tests') {
          continue;
        }
        stack.push(next);
      } else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

const functionIds = new Set([...functionMap.matchAll(/feature_id:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
const verificationIds = new Set([...verificationMap.matchAll(/feature_id:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
const sourceAnchors = new Map();

for (const relRoot of sourceRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/feature_id:\s*([A-Za-z0-9._-]+)/g)) {
      const featureId = match[1];
      const files = sourceAnchors.get(featureId) || [];
      files.push(relFile);
      sourceAnchors.set(featureId, files);
    }
  }
}

const failures = [];

for (const [featureId, files] of sourceAnchors.entries()) {
  if (!functionIds.has(featureId)) {
    failures.push(`${featureId}: source anchor exists but function-map entry missing (${files[0]})`);
  }
  if (!verificationIds.has(featureId)) {
    failures.push(`${featureId}: source anchor exists but verification-map entry missing (${files[0]})`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-feature-map-growth-discipline] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-feature-map-growth-discipline] ok');
console.log(`- checked source feature anchors: ${sourceAnchors.size}`);
