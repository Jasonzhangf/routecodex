import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const scripts = pkg.scripts || {};

const requiredScript = 'verify:function-map-compile-gate';
const requiredReviewSurfaceLightScript = 'verify:architecture-review-surface-light';
const requiredNodeIdConsistencyScript = 'verify:architecture-mainline-node-id-consistency';
const requiredReviewSurfaceScript = 'verify:architecture-review-surface';
const requiredLongtailScript = 'verify:architecture-ci-longtail';
const requiredBuildTieringScript = 'verify:build-script-tiering';
const compileGate = scripts[requiredScript] || '';
const requiredGateParts = [
  'verify:architecture-feature-id-anchors',
  'verify:architecture-feature-anchor-coverage',
  'verify:architecture-feature-map-growth-discipline',
  'verify:architecture-owner-queryability',
  'verify:function-map-coverage',
  'verify:function-map-paths',
  'verify:function-map-boundary-mentions',
  'verify:function-map-owner-uniqueness',
  'verify:function-map-canonical-builder-definitions',
  'verify:function-map-forbidden-mentions',
  'verify:function-map-required-tests',
  'verify:function-map-build-wiring',
];

const failures = [];

if (!compileGate) {
  failures.push(`package.json missing scripts.${requiredScript}`);
} else {
  for (const part of requiredGateParts) {
    if (!compileGate.includes(`npm run ${part}`)) {
      failures.push(`${requiredScript} missing required gate: ${part}`);
    }
  }
}

for (const buildScriptName of ['build', 'build:min']) {
  const command = scripts[buildScriptName] || '';
  if (!command.includes(`npm run ${requiredReviewSurfaceLightScript}`)) {
    failures.push(`${buildScriptName} must run ${requiredReviewSurfaceLightScript}`);
  }
  if (!command.includes(`npm run ${requiredScript}`)) {
    failures.push(`${buildScriptName} must run ${requiredScript}`);
  }
  const tscIndex = command.indexOf('tsc');
  const reviewSurfaceIndex = command.indexOf(`npm run ${requiredReviewSurfaceLightScript}`);
  const gateIndex = command.indexOf(`npm run ${requiredScript}`);
  if (tscIndex !== -1 && (reviewSurfaceIndex === -1 || reviewSurfaceIndex > tscIndex)) {
    failures.push(`${buildScriptName} must run ${requiredReviewSurfaceLightScript} before tsc`);
  }
  if (tscIndex !== -1 && (gateIndex === -1 || gateIndex > tscIndex)) {
    failures.push(`${buildScriptName} must run ${requiredScript} before tsc`);
  }
}

const reviewSurfaceLight = scripts[requiredReviewSurfaceLightScript] || '';
if (!reviewSurfaceLight.includes(`npm run ${requiredNodeIdConsistencyScript}`)) {
  failures.push(`${requiredReviewSurfaceLightScript} must run ${requiredNodeIdConsistencyScript}`);
}

const architectureCiLongtail = scripts[requiredLongtailScript] || '';
if (!architectureCiLongtail.includes(`npm run ${requiredBuildTieringScript}`)) {
  failures.push(`${requiredLongtailScript} must run ${requiredBuildTieringScript}`);
}

const architectureCi = scripts['verify:architecture-ci'] || '';
if (!architectureCi.includes(`npm run ${requiredReviewSurfaceScript}`)) {
  failures.push(`verify:architecture-ci must run ${requiredReviewSurfaceScript}`);
}
if (!architectureCi.includes('npm run verify:function-map-build-wiring')) {
  failures.push('verify:architecture-ci must run verify:function-map-build-wiring');
}
if (!architectureCi.includes(`npm run ${requiredLongtailScript}`)) {
  failures.push(`verify:architecture-ci must run ${requiredLongtailScript}`);
}

if (failures.length > 0) {
  console.error('[verify:function-map-build-wiring] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:function-map-build-wiring] ok');
console.log(`- build scripts require ${requiredScript}`);
console.log(`- build scripts require ${requiredReviewSurfaceLightScript}`);
console.log(`- ${requiredLongtailScript} requires ${requiredBuildTieringScript}`);
