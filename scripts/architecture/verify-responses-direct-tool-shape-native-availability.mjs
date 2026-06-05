import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, 'package.json'));

const { REQUIRED_NATIVE_HOTPATH_EXPORTS } = requireFromRoot('./sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.ts');

const candidate = path.join(root, 'sharedmodule/llmswitch-core/rust-core/target/release/router_hotpath_napi.node');
const binding = requireFromRoot(candidate);

const failures = [];

if (typeof binding !== 'object' || !binding) {
  failures.push('native router_hotpath_napi.node did not load as object');
}

if (!REQUIRED_NATIVE_HOTPATH_EXPORTS.includes('validateResponsesDirectToolShapeContractJson')) {
  failures.push('required native exports list missing validateResponsesDirectToolShapeContractJson');
}
if (!REQUIRED_NATIVE_HOTPATH_EXPORTS.includes('buildResponsesDirectPassthroughBodyJson')) {
  failures.push('required native exports list missing buildResponsesDirectPassthroughBodyJson');
}
if (!REQUIRED_NATIVE_HOTPATH_EXPORTS.includes('hasDeclaredApplyPatchToolJson')) {
  failures.push('required native exports list missing hasDeclaredApplyPatchToolJson');
}
if (!REQUIRED_NATIVE_HOTPATH_EXPORTS.includes('evaluateResponsesDirectRouteDecisionJson')) {
  failures.push('required native exports list missing evaluateResponsesDirectRouteDecisionJson');
}

if (typeof binding?.validateResponsesDirectToolShapeContractJson !== 'function') {
  failures.push('native binding missing validateResponsesDirectToolShapeContractJson export');
}
if (typeof binding?.buildResponsesDirectPassthroughBodyJson !== 'function') {
  failures.push('native binding missing buildResponsesDirectPassthroughBodyJson export');
}
if (typeof binding?.hasDeclaredApplyPatchToolJson !== 'function') {
  failures.push('native binding missing hasDeclaredApplyPatchToolJson export');
}
if (typeof binding?.evaluateResponsesDirectRouteDecisionJson !== 'function') {
  failures.push('native binding missing evaluateResponsesDirectRouteDecisionJson export');
}

const missingRequired = REQUIRED_NATIVE_HOTPATH_EXPORTS.filter((key) => typeof binding?.[key] !== 'function');
if (missingRequired.length > 0) {
  failures.push(`native binding missing required exports: ${missingRequired.slice(0, 10).join(', ')}`);
}

if (failures.length > 0) {
  console.error('[verify:responses-direct-tool-shape-native-availability] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-direct-tool-shape-native-availability] ok');
console.log(`- checked native binding: ${candidate}`);
