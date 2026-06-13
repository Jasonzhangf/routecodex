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
        summary: '',
        ownerKind: '',
        ownerModule: '',
        ownerScope: '',
        canonicalTypes: [],
        canonicalBuilders: [],
        allowedPaths: [],
        requiredTests: [],
        requiredGates: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;

    if (trimmed.startsWith('summary:')) {
      current.summary = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed.startsWith('owner_kind:')) {
      current.ownerKind = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed.startsWith('owner_module:')) {
      current.ownerModule = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed.startsWith('owner_scope:')) {
      current.ownerScope = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed === 'canonical_types:') {
      section = 'canonicalTypes';
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
    if (trimmed === 'required_tests:') {
      section = 'requiredTests';
      continue;
    }
    if (trimmed === 'required_gates:') {
      section = 'requiredGates';
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
const owners = parseOwners(mapText);

for (const owner of owners) {
  if (!owner.featureId) failures.push('feature_id missing');
  if (!owner.summary) failures.push(`${owner.featureId}: summary missing`);
  if (!owner.ownerKind) failures.push(`${owner.featureId}: owner_kind missing`);
  if (!owner.ownerModule) failures.push(`${owner.featureId}: owner_module missing`);
  if (!owner.ownerScope) failures.push(`${owner.featureId}: owner_scope missing`);
  if (owner.ownerModule && !fs.existsSync(path.join(root, owner.ownerModule))) {
    failures.push(`${owner.featureId}: owner_module path missing on disk: ${owner.ownerModule}`);
  }
  if (owner.canonicalTypes.length === 0) failures.push(`${owner.featureId}: canonical_types missing`);
  if (owner.canonicalBuilders.length === 0) failures.push(`${owner.featureId}: canonical_builders missing`);
  if (owner.allowedPaths.length === 0) failures.push(`${owner.featureId}: allowed_paths missing`);
  if (owner.requiredTests.length === 0) failures.push(`${owner.featureId}: required_tests missing`);
  if (owner.requiredGates.length === 0) failures.push(`${owner.featureId}: required_gates missing`);

  const anchor = `feature_id: ${owner.featureId}`;
  const searchPaths = Array.from(new Set([owner.ownerModule, ...owner.allowedPaths].filter(Boolean)));
  let anchorHit = false;
  let builderHit = false;
  for (const relPath of searchPaths) {
    for (const file of listFiles(relPath)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!anchorHit && source.includes(anchor)) anchorHit = true;
      if (!builderHit && owner.canonicalBuilders.some((builder) => source.includes(builder))) builderHit = true;
      if (anchorHit && builderHit) break;
    }
    if (anchorHit && builderHit) break;
  }
  if (!anchorHit) failures.push(`${owner.featureId}: source anchor missing from owner/allowed paths`);
  if (!builderHit) failures.push(`${owner.featureId}: canonical builder not queryable under owner/allowed paths`);

  for (const testPath of owner.requiredTests) {
    if (!fs.existsSync(path.join(root, testPath))) {
      failures.push(`${owner.featureId}: required test missing on disk: ${testPath}`);
    }
  }
  for (const gateCmd of owner.requiredGates) {
    const match = gateCmd.match(/^npm run ([A-Za-z0-9:_-]+)$/);
    if (!match) {
      failures.push(`${owner.featureId}: required gate must use npm run <script>: ${gateCmd}`);
      continue;
    }
    if (!scripts[match[1]]) {
      failures.push(`${owner.featureId}: required gate missing in package.json: ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-owner-queryability] failed');
  failures.slice(0, 120).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 120) console.error(`- ... ${failures.length - 120} more`);
  process.exit(1);
}

console.log('[verify:architecture-owner-queryability] ok');
console.log(`- checked features: ${owners.length}`);
