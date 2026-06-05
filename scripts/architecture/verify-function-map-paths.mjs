import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const text = fs.readFileSync(mapPath, 'utf8');

const lines = text.split('\n');
const failures = [];
const features = [];
let current = null;
let currentSection = null;

for (const rawLine of lines) {
  const line = rawLine.replace(/\r$/, '');
  const trimmed = line.trim();

  if (trimmed.startsWith('- feature_id:')) {
    if (current) features.push(current);
    current = { featureId: trimmed.split(':').slice(1).join(':').trim(), allowed: [], forbidden: [] };
    currentSection = null;
    continue;
  }

  if (!current) continue;

  if (trimmed === 'allowed_paths:') {
    currentSection = 'allowed';
    continue;
  }
  if (trimmed === 'forbidden_paths:') {
    currentSection = 'forbidden';
    continue;
  }
  if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('- ')) {
    currentSection = null;
    continue;
  }
  if (currentSection && trimmed.startsWith('- ')) {
    current[currentSection].push(trimmed.slice(2).trim());
  }
}
if (current) features.push(current);

if (features.length === 0) failures.push('no feature rows found in function-map');

for (const feature of features) {
  if (feature.allowed.length === 0) {
    failures.push(`${feature.featureId}: missing allowed_paths`);
    continue;
  }
  if (feature.forbidden.length === 0) {
    failures.push(`${feature.featureId}: missing forbidden_paths`);
  }

  const hasAllowedHit = feature.allowed.some((rel) => fs.existsSync(path.join(root, rel)));
  if (!hasAllowedHit) failures.push(`${feature.featureId}: no allowed_path exists on disk`);

  for (const rel of feature.forbidden) {
    if (!fs.existsSync(path.join(root, rel))) {
      failures.push(`${feature.featureId}: forbidden_path missing on disk: ${rel}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-paths] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:function-map-paths] ok');
console.log(`- checked ${features.length} features for allowed/forbidden path presence`);
