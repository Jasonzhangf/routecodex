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
        canonicalBuilders: [],
        forbiddenPaths: [],
        forbiddenMentionsAllowlist: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;

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
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (stat.isFile()) return [abs];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (/\.(rs|ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(next);
    }
  }
  return out;
}

const owners = parseOwners(mapText);
const failures = [];

for (const owner of owners) {
  const allowset = new Set(owner.forbiddenMentionsAllowlist);
  for (const builder of owner.canonicalBuilders) {
    if (allowset.has(builder)) continue;
    for (const relPath of owner.forbiddenPaths) {
      for (const file of listFiles(relPath)) {
        let text;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            continue;
          }
          throw error;
        }
        if (text.includes(builder)) {
          failures.push(
            `${owner.featureId}: canonical builder "${builder}" found in forbidden path ${path.relative(root, file)}`
          );
          break;
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-forbidden-mentions] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:function-map-forbidden-mentions] ok');
console.log(`- checked ${owners.length} features for forbidden path mentions`);
