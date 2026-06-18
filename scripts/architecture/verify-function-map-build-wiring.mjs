import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const scripts = pkg.scripts || {};

const requiredScript = 'verify:function-map-compile-gate';
const requiredReviewSurfaceLightScript = 'verify:architecture-review-surface-light';
const requiredReviewSurfaceScript = 'verify:architecture-review-surface';
const requiredLongtailScript = 'verify:architecture-ci-longtail';
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

// build:base must run review surface light + function-map compile gate (before tsc)
const baseCommand = scripts['build:base'] || '';
if (!baseCommand) {
  failures.push('package.json missing scripts.build:base');
} else {
  if (!baseCommand.includes(`npm run ${requiredReviewSurfaceLightScript}`)) {
    failures.push('build:base must run verify:architecture-review-surface-light');
  }
  if (!baseCommand.includes(`npm run ${requiredScript}`)) {
    failures.push('build:base must run verify:function-map-compile-gate');
  }
  const tscIndex = baseCommand.indexOf('tsc');
  const reviewSurfaceIndex = baseCommand.indexOf(`npm run ${requiredReviewSurfaceLightScript}`);
  const gateIndex = baseCommand.indexOf(`npm run ${requiredScript}`);
  if (tscIndex !== -1 && (reviewSurfaceIndex === -1 || reviewSurfaceIndex > tscIndex)) {
    failures.push('build:base must run verify:architecture-review-surface-light before tsc');
  }
  if (tscIndex !== -1 && (gateIndex === -1 || gateIndex > tscIndex)) {
    failures.push('build:base must run verify:function-map-compile-gate before tsc');
  }
}

// build must run build:base + verify:architecture-ci
const buildCommand = scripts['build'] || '';
if (!buildCommand) {
  failures.push('package.json missing scripts.build');
} else {
  if (!buildCommand.includes('npm run build:base')) {
    failures.push('build must run build:base');
  }
  if (!buildCommand.includes('npm run verify:architecture-ci')) {
    failures.push('build must run verify:architecture-ci');
  }
}

// build:dev and build:dev:full must use build:base
for (const devScript of ['build:dev', 'build:dev:full']) {
  const devCommand = scripts[devScript] || '';
  if (devCommand && !devCommand.includes('npm run build:base')) {
    failures.push(`${devScript} must use build:base`);
  }
}

const architectureCi = scripts['verify:architecture-ci'] || '';
if (!architectureCi.includes(`npm run ${requiredReviewSurfaceScript}`)) {
  failures.push('verify:architecture-ci must run verify:architecture-review-surface');
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
console.log('- build:base requires verify:architecture-review-surface-light and verify:function-map-compile-gate');
console.log('- build requires build:base and verify:architecture-ci');
console.log('- build:dev and build:dev:full use build:base');
console.log('- verify:architecture-ci requires verify:architecture-review-surface, verify:function-map-build-wiring, and verify:architecture-ci-longtail');
