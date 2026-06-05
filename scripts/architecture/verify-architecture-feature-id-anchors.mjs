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
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- feature_id:')) {
      if (current) owners.push(current);
      current = {
        featureId: trimmed.split(':').slice(1).join(':').trim(),
        ownerModule: '',
        allowedPaths: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('owner_module:')) {
      current.ownerModule = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed === 'allowed_paths:') {
      section = 'allowedPaths';
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
        if (entry.name === 'dist' || entry.name === 'node_modules') continue;
        stack.push(next);
      } else if (/\.(rs|ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

const owners = parseOwners(mapText);
const failures = [];

for (const owner of owners) {
  const anchor = `feature_id: ${owner.featureId}`;
  const searchPaths = Array.from(new Set([owner.ownerModule, ...owner.allowedPaths]));
  let hit = false;
  for (const relPath of searchPaths) {
    for (const file of listFiles(relPath)) {
      if (fs.readFileSync(file, 'utf8').includes(anchor)) {
        hit = true;
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    failures.push(`${owner.featureId}: missing source anchor "${anchor}" under owner/allowed paths`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-feature-id-anchors] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-feature-id-anchors] ok');
console.log(`- checked ${owners.length} features for source anchors`);
