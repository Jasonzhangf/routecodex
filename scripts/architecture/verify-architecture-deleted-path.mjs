import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const pkgPath = path.join(root, 'package.json');
const mapText = fs.readFileSync(mapPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const scripts = pkg.scripts || {};

function parseOwners(text) {
  const lines = text.split('\n');
  const owners = [];
  let current = null;
  let section = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- feature_id:')) {
      if (current) owners.push(current);
      current = {
        featureId: trimmed.split(':').slice(1).join(':').trim(),
        allowedPaths: [],
        forbiddenPaths: [],
        requiredTests: [],
        requiredGates: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;
    if (trimmed === 'allowed_paths:') { section = 'allowedPaths'; continue; }
    if (trimmed === 'forbidden_paths:') { section = 'forbiddenPaths'; continue; }
    if (trimmed === 'required_tests:') { section = 'requiredTests'; continue; }
    if (trimmed === 'required_gates:') { section = 'requiredGates'; continue; }
    if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('- ')) {
      section = null;
      continue;
    }
    if (section && trimmed.startsWith('- ')) current[section].push(trimmed.slice(2).trim());
  }
  if (current) owners.push(current);
  return owners;
}

const failures = [];
for (const owner of parseOwners(mapText)) {
  for (const rel of owner.allowedPaths) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`${owner.featureId}: allowed_path missing on disk -> ${rel}`);
    }
  }
  for (const rel of owner.requiredTests) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`${owner.featureId}: required_tests path missing on disk -> ${rel}`);
    }
  }
  for (const gate of owner.requiredGates) {
    const match = gate.match(/^npm run (\S+)$/);
    if (!match) continue;
    if (!scripts[match[1]]) {
      failures.push(`${owner.featureId}: required_gates script missing in package.json -> ${gate}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-deleted-path] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-deleted-path] ok');
console.log(`- checked ${parseOwners(mapText).length} features for dead allowed_paths / required_tests / required_gates`);
