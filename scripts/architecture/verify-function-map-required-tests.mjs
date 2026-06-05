import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const packageJsonPath = path.join(root, 'package.json');
const mapText = fs.readFileSync(mapPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
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
        requiredTests: [],
        requiredGates: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;

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

const owners = parseOwners(mapText);
const failures = [];

for (const owner of owners) {
  if (owner.requiredTests.length === 0) {
    failures.push(`${owner.featureId}: missing required_tests`);
  }
  if (owner.requiredGates.length === 0) {
    failures.push(`${owner.featureId}: missing required_gates`);
  }

  for (const testPath of owner.requiredTests) {
    if (!fs.existsSync(path.join(root, testPath))) {
      failures.push(`${owner.featureId}: required test missing on disk: ${testPath}`);
    }
  }

  for (const gateCmd of owner.requiredGates) {
    const match = gateCmd.match(/^npm run ([A-Za-z0-9:_-]+)$/);
    if (!match) {
      failures.push(`${owner.featureId}: required gate must use \"npm run <script>\": ${gateCmd}`);
      continue;
    }
    const scriptName = match[1];
    if (!scripts[scriptName]) {
      failures.push(`${owner.featureId}: required gate script missing in package.json: ${scriptName}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-required-tests] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:function-map-required-tests] ok');
console.log(`- checked ${owners.length} features for required_tests and required_gates`);
