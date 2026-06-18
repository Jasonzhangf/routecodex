/**
 * verify-function-map-test-coverage-integrity
 *
 * Cross-checks function-map required_tests against actual test file contents.
 * For each feature with required_tests:
 * 1. Extract keywords from feature_id + owner_module
 * 2. Check if test file contains at least one keyword or relevant import
 * 3. If test file exists but is completely unrelated -> FAIL
 *
 * Best-effort: allows pass if keywords are too generic; only hard-FAILs
 * when the test file clearly doesn't reference the feature at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const functionMapPath = path.join(root, 'docs/architecture/function-map.yml');
const functionMap = YAML.parse(fs.readFileSync(functionMapPath, 'utf8'));

const failures = [];
const warnings = [];

// Keyword extractor from feature_id and owner_module
function extractKeywords(featureId, ownerModule) {
  const tokens = [];
  const add = (s) => {
    if (s && s.length > 2) tokens.push(s.toLowerCase());
  };
  // Split on dots and underscores
  const parts = [...(featureId?.split(/\.|\//) ?? []), ...(ownerModule?.split(/\.|\//) ?? [])];
  for (const p of parts) {
    add(p.replace(/[_-]/g, ''));
  }
  return tokens;
}

// Check if file content mentions any keyword
function fileMentionsKeywords(absPath, keywords) {
  if (!fs.existsSync(absPath)) return true; // missing already caught by other gate
  const content = fs.readFileSync(absPath, 'utf8').toLowerCase();
  let found = 0;
  for (const kw of keywords) {
    if (kw.length < 3) continue;
    if (content.includes(kw)) found++;
  }
  return found;
}

const owners = functionMap?.owners ?? [];
let checked = 0;

for (const owner of owners) {
  const featureId = owner?.feature_id ?? '';
  const ownerModule = owner?.owner_module ?? '';
  const requiredTests = Array.isArray(owner?.required_tests) ? owner.required_tests : [];

  if (requiredTests.length === 0) continue;

  const keywords = extractKeywords(featureId, ownerModule);
  if (keywords.length === 0) {
    warnings.push(`${featureId}: no extractable keywords for coverage check`);
    continue;
  }

  for (const testRel of requiredTests) {
    checked++;
    const absPath = path.join(root, testRel);
    if (!fs.existsSync(absPath)) {
      // missing file — already caught by verify:function-map-required-tests
      continue;
    }

    const matchCount = fileMentionsKeywords(absPath, keywords);

    // If zero keywords found and feature_id is specific (contains at least 3 parts), flag it
    if (matchCount === 0 && featureId.split('.').length >= 3) {
      // Try harder: check for related terms (e.g., "servertool" for "servertool_*" features)
      const fallbackTerms = keywords.slice(0, 2).filter(k => k.length >= 4);
      const fallbackHits = fileMentionsKeywords(absPath, fallbackTerms);
      if (fallbackHits === 0) {
        failures.push(`${featureId}: test '${testRel}' exists but does not mention feature keywords ${JSON.stringify(keywords)}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:function-map-test-coverage-integrity] failed');
  for (const f of failures) console.error(`- ${f}`);
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`- ${w}`);
  }
  process.exit(1);
}

console.log('[verify:function-map-test-coverage-integrity] ok');
console.log(`- checked ${checked} test entries across ${owners.length} features`);
if (warnings.length > 0) {
  for (const w of warnings) console.warn(`- ${w}`);
}
