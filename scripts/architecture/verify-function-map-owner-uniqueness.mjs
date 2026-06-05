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
        canonicalBuilders: [],
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
    if (trimmed === 'canonical_builders:') {
      section = 'canonicalBuilders';
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

const owners = parseOwners(mapText);
const failures = [];
const builderToFeature = new Map();

for (const owner of owners) {
  if (!owner.ownerModule) {
    failures.push(`${owner.featureId}: missing owner_module`);
  }

  const ownerCovered = owner.allowedPaths.some((allowedPath) => {
    return owner.ownerModule === allowedPath || owner.ownerModule.startsWith(`${allowedPath}/`);
  });
  if (!ownerCovered) {
    failures.push(
      `${owner.featureId}: owner_module not covered by allowed_paths (${owner.ownerModule})`
    );
  }

  for (const builder of owner.canonicalBuilders) {
    const existing = builderToFeature.get(builder);
    if (existing && existing !== owner.featureId) {
      failures.push(
        `canonical builder declared by multiple features: ${builder} -> ${existing}, ${owner.featureId}`
      );
    } else {
      builderToFeature.set(builder, owner.featureId);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-owner-uniqueness] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:function-map-owner-uniqueness] ok');
console.log(`- checked ${owners.length} features`);
console.log(`- checked ${builderToFeature.size} canonical builders for uniqueness`);
