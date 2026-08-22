import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const installGlobalScript = fs.readFileSync(path.join(root, 'scripts/install-global.sh'), 'utf8');
const installReleaseScript = fs.readFileSync(path.join(root, 'scripts/install-release.sh'), 'utf8');
const failures = [];

function has(scriptName, token) {
  return String(scripts[scriptName] ?? '').includes(token);
}

if (!has('build:min', 'npm run verify:architecture-review-surface-light')) {
  failures.push('build:min must run verify:architecture-review-surface-light');
}
if (!has('build:min', 'npm run verify:function-map-compile-gate')) {
  failures.push('build:min must run verify:function-map-compile-gate');
}
if (!has('build', 'npm run verify:architecture-review-surface-light')) {
  failures.push('build must run verify:architecture-review-surface-light');
}
if (!has('build', 'npm run verify:function-map-compile-gate')) {
  failures.push('build must run verify:function-map-compile-gate');
}
if (!has('verify:architecture-review-surface-light', 'verify:architecture-mainline-node-id-consistency')) {
  failures.push('review surface light must include mainline node-id consistency gate');
}
if (!has('verify:architecture-review-surface-light', 'verify:architecture-manifest-sync')) {
  failures.push('review surface light must include mainline manifest sync gate');
}
if (!has('verify:architecture-ci', 'verify:architecture-topology-doc-sync')) {
  failures.push('architecture-ci should include topology doc sync gate');
}
if (!has('verify:architecture-ci', 'verify:function-map-required-tests-bidir')) {
  failures.push('architecture-ci should include required-tests bidir gate');
}
if (!installGlobalScript.includes('npm run build:min')) {
  failures.push('scripts/install-global.sh must run npm run build:min');
}
if (!installReleaseScript.includes('npm run build:min')) {
  failures.push('scripts/install-release.sh must run npm run build:min');
}

if (failures.length > 0) {
  console.error('[verify:build-script-tiering] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:build-script-tiering] ok');
console.log('- build tiering and CI wiring are consistent with architecture gates');
