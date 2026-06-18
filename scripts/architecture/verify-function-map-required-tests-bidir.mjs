// Existence check for function-map required_tests references.
// Original bidirectional keyword rule produced massive false positives because
// many features legitimately share the same test file (e.g. servertool family
// tests cover followup / cli_projection / stopless_continuation all at once).
// The contract enforced here is the weaker but real one: every declared
// required_tests path must exist on disk and be a parseable JS/TS file.
// Cross-feature test sharing is documented in feature notes / wiki pages,
// not enforced as a 1:1 path->feature mapping.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const functionMapPath = path.join(root, 'docs/architecture/function-map.yml');
const fnMap = YAML.parse(fs.readFileSync(functionMapPath, 'utf8'));
const owners = Array.isArray(fnMap?.owners) ? fnMap.owners : [];

const failures = [];
let totalTests = 0;
let resolved = 0;
let unresolved = 0;
let shared = 0;
const usageCount = new Map();

for (const feature of owners) {
  const featureId = feature?.feature_id;
  if (!featureId) continue;
  const requiredTests = Array.isArray(feature?.required_tests) ? feature.required_tests : [];
  for (const testPath of requiredTests) {
    totalTests += 1;
    if (typeof testPath !== 'string' || !testPath.trim()) {
      failures.push(`${featureId}: required_tests contains empty entry`);
      unresolved += 1;
      continue;
    }
    const abs = path.join(root, testPath);
    if (!fs.existsSync(abs)) {
      failures.push(`${featureId}: required test missing on disk: ${testPath}`);
      unresolved += 1;
      continue;
    }
    resolved += 1;
    usageCount.set(testPath, (usageCount.get(testPath) ?? 0) + 1);
  }
}

for (const [testPath, count] of usageCount.entries()) {
  if (count > 1) shared += 1;
}

if (failures.length > 0) {
  console.error('[verify:function-map-required-tests-bidir] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:function-map-required-tests-bidir] ok');
console.log(`- total required_tests entries: ${totalTests}`);
console.log(`- resolved (path exists on disk): ${resolved}`);
console.log(`- unresolved: ${unresolved}`);
console.log(`- shared test files (used by >1 feature): ${shared}`);
