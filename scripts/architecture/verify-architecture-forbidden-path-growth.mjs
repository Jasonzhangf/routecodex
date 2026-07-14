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
        canonicalTypes: [],
        canonicalBuilders: [],
        forbiddenPaths: [],
        forbiddenMentionsAllowlist: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;

    if (trimmed === 'canonical_types:') {
      section = 'canonicalTypes';
      continue;
    }
    if (trimmed === 'canonical_builders:') {
      section = 'canonicalBuilders';
      continue;
    }
    if (trimmed === 'forbidden_paths:') {
      section = 'forbiddenPaths';
      continue;
    }
    if (trimmed === 'forbidden_mentions_allowlist:') {
      section = 'forbiddenMentionsAllowlist';
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
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'tests') {
          continue;
        }
        stack.push(next);
      } else if (/\.(rs|ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

const failures = [];
let checkedFeatures = 0;

function isIdentifierChar(value) {
  return /[A-Za-z0-9_]/.test(value);
}

function containsIdentifier(source, pattern) {
  let index = source.indexOf(pattern);
  while (index !== -1) {
    const before = index > 0 ? source[index - 1] : '';
    const after = index + pattern.length < source.length ? source[index + pattern.length] : '';
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
      return true;
    }
    index = source.indexOf(pattern, index + pattern.length);
  }
  return false;
}

for (const owner of parseOwners(mapText)) {
  checkedFeatures += 1;
  const patterns = [...owner.canonicalTypes, ...owner.canonicalBuilders];
  const allowset = new Set(owner.forbiddenMentionsAllowlist);
  for (const pattern of patterns) {
    if (allowset.has(pattern)) continue;
    for (const relPath of owner.forbiddenPaths) {
      for (const file of listFiles(relPath)) {
        const relFile = path.relative(root, file);
        if (containsIdentifier(fs.readFileSync(file, 'utf8'), pattern)) {
          failures.push(`${owner.featureId}: "${pattern}" found in forbidden path ${relFile}`);
          break;
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-forbidden-path-growth] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-forbidden-path-growth] ok');
console.log(`- checked features: ${checkedFeatures}`);
