import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapText = fs.readFileSync(path.join(root, 'docs/architecture/function-map.yml'), 'utf8');

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
        ownerScope: '',
        ownerModule: '',
        allowedPaths: [],
        canonicalBuilders: []
      };
      section = null;
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('owner_scope:')) {
      current.ownerScope = trimmed.slice('owner_scope:'.length).trim();
      section = null;
      continue;
    }
    if (trimmed.startsWith('owner_module:')) {
      current.ownerModule = trimmed.slice('owner_module:'.length).trim();
      section = null;
      continue;
    }
    if (trimmed === 'allowed_paths:') {
      section = 'allowedPaths';
      continue;
    }
    if (trimmed === 'canonical_builders:') {
      section = 'canonicalBuilders';
      continue;
    }
    if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('- ')) {
      section = null;
      continue;
    }
    if (section && trimmed.startsWith('- ')) current[section].push(trimmed.slice(2).trim());
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
        if (entry.name === 'dist' || entry.name === 'node_modules') continue;
        stack.push(next);
      } else if (/\.(rs|ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

const failures = [];
for (const owner of parseOwners(mapText)) {
  const anchor = `feature_id: ${owner.featureId}`;
  let anchorFiles = 0;
  const builderHitFiles = new Set();
  for (const relPath of owner.allowedPaths) {
    for (const file of listFiles(relPath)) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes(anchor)) anchorFiles += 1;
      if (owner.canonicalBuilders.some((builder) => source.includes(builder))) {
        builderHitFiles.add(path.relative(root, file));
      }
    }
  }
  const isFileScopedOwner =
    owner.ownerScope.toLowerCase().includes('file-scoped')
    || owner.ownerModule.toLowerCase().includes('file-scoped');
  const minBuilderHitFiles = isFileScopedOwner ? 1 : 2;
  if (anchorFiles < 1) failures.push(`${owner.featureId}: needs at least 1 source anchor file`);
  if (builderHitFiles.size < minBuilderHitFiles) {
    failures.push(
      `${owner.featureId}: needs canonical builder hits in at least ${minBuilderHitFiles} files, got ${builderHitFiles.size}`
    );
  }
}

if (failures.length) {
  console.error('[verify:architecture-feature-anchor-coverage] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:architecture-feature-anchor-coverage] ok');
console.log(`- checked ${parseOwners(mapText).length} features`);
