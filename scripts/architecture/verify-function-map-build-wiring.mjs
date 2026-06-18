import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const scripts = pkg.scripts || {};

// Build wiring contract:
// - build/build:min must block on review-surface-light + function-map-compile-gate before tsc
// - review-surface-light now includes mainline node-id consistency, binding debt budget,
//   mainline manifest sync, and topology debt budget
// - architecture-ci now includes required-tests-bidir + build-tiering
// - longtail remains the place for slower / debt-reporting architecture checks
const requiredScript = 'verify:function-map-compile-gate';
const requiredReviewSurfaceLightScript = 'verify:architecture-review-surface-light';
const requiredNodeIdConsistencyScript = 'verify:architecture-mainline-node-id-consistency';
const requiredBindingBudgetScript = 'verify:architecture-mainline-binding-pending-gate';
const requiredTopologyBudgetScript = 'verify:architecture-topology-doc-sync';
const requiredMetadataCenterManifestCodeSyncScript = 'verify:architecture-metadata-center-manifest-code-sync';
const requiredReviewSurfaceScript = 'verify:architecture-review-surface';
const requiredLongtailScript = 'verify:architecture-ci-longtail';
const requiredBuildTieringScript = 'verify:build-script-tiering';
const requiredCustomPayloadContainmentScript = 'verify:architecture-custom-payload-carrier-containment';
const requiredCustomPayloadOwnerQueryabilityScript = 'verify:architecture-custom-payload-carrier-owner-queryability';
const requiredCustomPayloadRuntimeManifestScript = 'verify:architecture-custom-payload-carrier-runtime-manifest';
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
if (!reviewSurfaceLight.includes(`npm run ${requiredBindingBudgetScript}`)) {
  failures.push(`${requiredReviewSurfaceLightScript} must run ${requiredBindingBudgetScript}`);
}
if (!reviewSurfaceLight.includes(`npm run ${requiredTopologyBudgetScript}`)) {
  failures.push(`${requiredReviewSurfaceLightScript} must run ${requiredTopologyBudgetScript}`);
}
if (!reviewSurfaceLight.includes(`npm run ${requiredMetadataCenterManifestCodeSyncScript}`)) {
  failures.push(`${requiredReviewSurfaceLightScript} must run ${requiredMetadataCenterManifestCodeSyncScript}`);
}

const architectureCiLongtail = scripts[requiredLongtailScript] || '';
if (!architectureCiLongtail.includes(`npm run ${requiredBuildTieringScript}`)) {
  failures.push(`${requiredLongtailScript} must run ${requiredBuildTieringScript}`);
}
if (!architectureCiLongtail.includes(`npm run ${requiredCustomPayloadContainmentScript}`)) {
  failures.push(`${requiredLongtailScript} must run ${requiredCustomPayloadContainmentScript}`);
}
if (!architectureCiLongtail.includes(`npm run ${requiredCustomPayloadOwnerQueryabilityScript}`)) {
  failures.push(`${requiredLongtailScript} must run ${requiredCustomPayloadOwnerQueryabilityScript}`);
}
if (!architectureCiLongtail.includes(`npm run ${requiredCustomPayloadRuntimeManifestScript}`)) {
  failures.push(`${requiredLongtailScript} must run ${requiredCustomPayloadRuntimeManifestScript}`);
}

const architectureCi = scripts['verify:architecture-ci'] || '';
if (!architectureCi.includes(`npm run ${requiredReviewSurfaceScript}`)) {
  failures.push(`verify:architecture-ci must run ${requiredReviewSurfaceScript}`);
}
if (!architectureCi.includes('npm run verify:function-map-build-wiring')) {
  failures.push('verify:architecture-ci must run verify:function-map-build-wiring');
}
if (!architectureCi.includes(`npm run ${requiredTopologyBudgetScript}`)) {
  failures.push(`verify:architecture-ci must run ${requiredTopologyBudgetScript}`);
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
console.log(`- ${requiredReviewSurfaceLightScript} requires ${requiredBindingBudgetScript}`);
console.log(`- ${requiredReviewSurfaceLightScript} requires ${requiredTopologyBudgetScript}`);
console.log(`- ${requiredReviewSurfaceLightScript} requires ${requiredMetadataCenterManifestCodeSyncScript}`);
console.log(`- ${requiredLongtailScript} requires ${requiredBuildTieringScript}`);
console.log(`- ${requiredLongtailScript} requires ${requiredCustomPayloadContainmentScript}`);
console.log(`- ${requiredLongtailScript} requires ${requiredCustomPayloadOwnerQueryabilityScript}`);
console.log(`- ${requiredLongtailScript} requires ${requiredCustomPayloadRuntimeManifestScript}`);
