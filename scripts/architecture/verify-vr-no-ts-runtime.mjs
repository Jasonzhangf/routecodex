import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcVrRoot = 'sharedmodule/llmswitch-core/src/router/virtual-router';
const distVrRoot = 'sharedmodule/llmswitch-core/dist/router/virtual-router';
const oldWrapperPath = 'router/virtual-router/engine-selection';

const scanRoots = [
  'sharedmodule/llmswitch-core/src',
  'src',
  'tests',
  'scripts',
  'docs',
  'package.json',
];

const scanExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md']);

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function listFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!fs.existsSync(absRoot)) return [];
  if (fs.statSync(absRoot).isFile()) return [absRoot];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules'
          || entry.name === '.git'
          || entry.name === 'target'
          || entry.name === 'coverage'
          || entry.name === '.rcc'
        ) {
          continue;
        }
        stack.push(next);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (scanExtensions.has(ext)) {
        out.push(next);
      }
    }
  }
  out.sort();
  return out;
}

function listVrProdTsFiles() {
  const absRoot = path.join(root, srcVrRoot);
  if (!fs.existsSync(absRoot)) return [];
  return listFiles(srcVrRoot)
    .map((abs) => path.relative(root, abs).split(path.sep).join('/'))
    .filter((rel) => rel.endsWith('.ts'))
    .filter((rel) => !rel.endsWith('.d.ts'))
    .filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.spec.ts'))
    .filter((rel) => !rel.includes('/test/') && !rel.includes('/tests/') && !rel.includes('/__tests__/'));
}

function isAllowedTextReference(relFile, line) {
  if (relFile === 'docs/goals/virtual-router-no-ts-runtime-plan.md') return true;
  if (relFile === 'scripts/architecture/verify-vr-no-ts-runtime.mjs') return true;
  if (relFile === 'scripts/ci/llmswitch-rustification-audit.mjs') return true;
  if (relFile === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts') return true;
  return line.includes('forbidden') || line.includes('forbid') || line.includes('禁止') || line.includes('deleted') || line.includes('delete');
}

const failures = [];

const vrProdTsFiles = listVrProdTsFiles();
if (vrProdTsFiles.length > 0) {
  failures.push(`production TS remains under ${srcVrRoot}: ${vrProdTsFiles.join(', ')}`);
}

if (exists(`${srcVrRoot}/engine-selection`)) {
  failures.push(`old source wrapper directory exists: ${srcVrRoot}/engine-selection`);
}

if (exists(`${distVrRoot}/engine-selection`)) {
  failures.push(`old dist wrapper directory exists: ${distVrRoot}/engine-selection`);
}

for (const file of scanRoots.flatMap(listFiles)) {
  const relFile = path.relative(root, file).split(path.sep).join('/');
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (!line.includes(oldWrapperPath)) return;
    if (isAllowedTextReference(relFile, line)) return;
    failures.push(`${relFile}:${index + 1}: old VR wrapper path reference: ${line.trim()}`);
  });
}

const functionMapPath = path.join(root, 'docs/architecture/function-map.yml');
if (fs.existsSync(functionMapPath)) {
  const lines = fs.readFileSync(functionMapPath, 'utf8').split('\n');
  let currentSection = '';
  lines.forEach((line, index) => {
    const sectionMatch = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    if (sectionMatch && sectionMatch[1].length >= 4) {
      currentSection = sectionMatch[2];
    }
    if (!line.includes(srcVrRoot)) return;
    if (currentSection !== 'allowed_paths') return;
    failures.push(`docs/architecture/function-map.yml:${index + 1}: function-map re-allows VR TS runtime path`);
  });
}

if (failures.length > 0) {
  console.error('[verify:vr-no-ts-runtime] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:vr-no-ts-runtime] ok');
console.log(`- checked roots: ${scanRoots.length}`);
console.log(`- VR production TS files: ${vrProdTsFiles.length}`);
