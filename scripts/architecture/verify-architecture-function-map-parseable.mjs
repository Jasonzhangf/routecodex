import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const files = [
  'docs/architecture/function-map.yml',
  'docs/architecture/verification-map.yml',
];

const failures = [];

for (const relPath of files) {
  const absPath = path.join(root, relPath);
  const source = fs.readFileSync(absPath, 'utf8');
  try {
    const parsed = YAML.parse(source);
    if (!parsed || typeof parsed !== 'object') {
      failures.push(`${relPath}: parsed to empty/non-object root`);
      continue;
    }
    if (!Array.isArray(parsed.owners) && !Array.isArray(parsed.verification)) {
      failures.push(`${relPath}: missing owners/verification top-level array`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push(`${relPath}: ${reason}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-function-map-parseable] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-function-map-parseable] ok');
console.log('- function-map and verification-map are valid YAML and machine-parseable');
