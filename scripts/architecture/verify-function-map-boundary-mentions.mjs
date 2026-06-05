import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const mapText = fs.readFileSync(mapPath, 'utf8');

function parseOwners(text) {
  const lines = text.split('\n');
  const owners = [];
  let current = null;
  let section = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed.startsWith('- feature_id:')) {
      if (current) owners.push(current);
      current = {
        featureId: trimmed.split(':').slice(1).join(':').trim(),
        canonicalBuilders: [],
        allowedPaths: [],
        forbiddenPaths: [],
      };
      section = null;
      continue;
    }

    if (!current) continue;

    if (trimmed === 'canonical_builders:') {
      section = 'canonicalBuilders';
      continue;
    }
    if (trimmed === 'allowed_paths:') {
      section = 'allowedPaths';
      continue;
    }
    if (trimmed === 'forbidden_paths:') {
      section = 'forbiddenPaths';
      continue;
    }
    if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('- ')) {
      section = null;
      continue;
    }
    if (section && trimmed.startsWith('- ')) {
      current[section].push(trimmed.slice(2).trim());
    }
  }
  if (current) owners.push(current);
  return owners;
}

function listFiles(relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];

  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (/\.(rs|ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        out.push(next);
      }
    }
  }
  return out;
}

const owners = parseOwners(mapText);
const failures = [];
const warnings = [];

for (const owner of owners) {
  for (const builder of owner.canonicalBuilders) {
    const hitInAllowed = owner.allowedPaths.some((relPath) => {
      return listFiles(relPath).some((file) => fs.readFileSync(file, 'utf8').includes(builder));
    });
    if (!hitInAllowed) {
      failures.push(`${owner.featureId}: canonical builder not found in allowed_paths: ${builder}`);
    }

    const hitInForbidden = owner.forbiddenPaths.some((relPath) => {
      return listFiles(relPath).some((file) => fs.readFileSync(file, 'utf8').includes(builder));
    });
    if (hitInForbidden) {
      warnings.push(`${owner.featureId}: canonical builder string appears in forbidden_paths: ${builder}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-boundary-mentions] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  if (warnings.length > 0) {
    console.error('[verify:function-map-boundary-mentions] warnings');
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log('[verify:function-map-boundary-mentions] ok');
console.log(`- checked ${owners.length} features`);
if (warnings.length > 0) {
  console.log(`- warnings: ${warnings.length}`);
  for (const warning of warnings) console.log(`  - ${warning}`);
}
