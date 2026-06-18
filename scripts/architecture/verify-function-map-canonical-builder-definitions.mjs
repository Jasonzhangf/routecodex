import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const mapText = fs.readFileSync(mapPath, 'utf8');
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs']);

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
        canonicalBuilders: [],
        allowedPaths: [],
        forbiddenPaths: [],
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
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage' || entry.name === 'target') continue;
        stack.push(next);
      } else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findDefinitionHits(relPath, builder) {
  const files = listFiles(relPath);
  const hits = [];
  const escaped = escapeRegExp(builder);
  const patterns = [
    new RegExp(`\\bexport\\s+function\\s+${escaped}\\b`),
    new RegExp(`\\bfunction\\s+${escaped}\\b`),
    new RegExp(`\\bfn\\s+${escaped}\\b`),
    new RegExp(`\\bpub(?:\\(crate\\))?\\s+fn\\s+${escaped}\\b`),
    new RegExp(`\\bpub\\(super\\)\\s+fn\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s+const\\s+${escaped}\\s*=`),
    new RegExp(`\\bconst\\s+${escaped}\\s*=`),
    new RegExp(`^\\s*(?:(?:public|private|protected)\\s+)?${escaped}(?:<[^>]+>)?\\s*\\([^)]*\\)\\s*[:{]`),
  ];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) {
        hits.push(`${path.relative(root, file)}:${index + 1}`);
      }
    });
  }
  return hits;
}

function collapseTsJsSiblingHits(hits) {
  const grouped = new Map();
  for (const hit of hits) {
    const [file, line] = hit.split(':');
    const normalizedFile = file.replace(/\.(ts|js|tsx|mjs|cjs)$/, '');
    const key = `${normalizedFile}:${line}`;
    const arr = grouped.get(key) || [];
    arr.push(hit);
    grouped.set(key, arr);
  }
  return Array.from(grouped.values()).map((group) => group.sort()[0]);
}

const owners = parseOwners(mapText);
const failures = [];

for (const owner of owners) {
  const ownerDefinitionCount = new Map();

  for (const builder of owner.canonicalBuilders) {
    const ownerHits = findDefinitionHits(owner.ownerModule, builder);
    const normalizedOwnerHits = collapseTsJsSiblingHits(ownerHits);
    if (normalizedOwnerHits.length === 0) {
      failures.push(`${owner.featureId}: owner_module missing canonical builder definition -> ${builder} @ ${owner.ownerModule}`);
      continue;
    }
    if (normalizedOwnerHits.length > 1) {
      failures.push(`${owner.featureId}: owner_module has multiple canonical builder definitions -> ${builder} :: ${normalizedOwnerHits.join(', ')}`);
    }
    ownerDefinitionCount.set(builder, normalizedOwnerHits.length);

    const allowedNonOwnerHits = collapseTsJsSiblingHits(owner.allowedPaths
      .filter((relPath) => relPath !== owner.ownerModule)
      .flatMap((relPath) => findDefinitionHits(relPath, builder)));
    if (allowedNonOwnerHits.length > 0) {
      failures.push(`${owner.featureId}: canonical builder redefined outside owner_module but inside allowed_paths -> ${builder} :: ${allowedNonOwnerHits.join(', ')}`);
    }

    const forbiddenHits = collapseTsJsSiblingHits(owner.forbiddenPaths.flatMap((relPath) => findDefinitionHits(relPath, builder)));
    if (forbiddenHits.length > 0) {
      failures.push(`${owner.featureId}: canonical builder defined in forbidden_paths -> ${builder} :: ${forbiddenHits.join(', ')}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-canonical-builder-definitions] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:function-map-canonical-builder-definitions] ok');
console.log(`- checked features: ${owners.length}`);
