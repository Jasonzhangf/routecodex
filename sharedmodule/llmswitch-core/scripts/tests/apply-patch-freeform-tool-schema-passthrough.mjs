#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const FEATURE_ID_APPLY_PATCH_FREEFORM_CONTRACT = 'feature_id: tool.apply_patch_freeform_contract';
const require = createRequire(import.meta.url);

function loadNativeBinding() {
  return require(path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node'));
}

function mapBridgeToolsToChat(rawTools) {
  const binding = loadNativeBinding();
  const fn = binding.mapBridgeToolsToChatWithOptionsJson ?? binding.mapBridgeToolsToChatJson;
  if (typeof fn !== 'function') {
    throw new Error('mapBridgeToolsToChat native export is required');
  }
  const payload =
    fn === binding.mapBridgeToolsToChatWithOptionsJson
      ? { tools: rawTools, options: {} }
      : { tools: rawTools };
  const raw = fn(JSON.stringify(payload));
  const parsed = JSON.parse(String(raw || '{}'));
  const mapped = Array.isArray(parsed) ? parsed : parsed?.tools;
  if (!Array.isArray(mapped)) {
    throw new Error('mapBridgeToolsToChat native export returned invalid tools');
  }
  return mapped;
}

function makeClientApplyPatchTool() {
  return {
    type: 'function',
    name: 'apply_patch',
    description: 'client apply_patch (freeform)',
    format: 'freeform',
    function: {
      name: 'apply_patch',
      description: 'client apply_patch (freeform)',
      format: 'freeform'
      // intentionally omit parameters
    }
  };
}

function hasStructuredChangesSchema(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  const props = parameters.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  return Object.prototype.hasOwnProperty.call(props, 'changes');
}

function hasLegacyFilePathSchema(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  const props = parameters.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  return Object.prototype.hasOwnProperty.call(props, 'filePath') || Object.prototype.hasOwnProperty.call(props, 'changes');
}

async function main() {
  assert.equal(FEATURE_ID_APPLY_PATCH_FREEFORM_CONTRACT, 'feature_id: tool.apply_patch_freeform_contract');

  const rawTool = makeClientApplyPatchTool();

  const mapped = mapBridgeToolsToChat([rawTool])?.[0];
  assert.ok(mapped, 'expected tool mapping to produce a definition');
  assert.ok(
    !hasStructuredChangesSchema(mapped.function?.parameters),
    'expected apply_patch schema to NOT include properties.changes'
  );
  assert.ok(
    !hasLegacyFilePathSchema(mapped.function?.parameters),
    'expected apply_patch schema to NOT include legacy filePath/changes contract'
  );
  assert.equal(
    mapped.function?.parameters,
    undefined,
    'expected apply_patch shared mapping to omit structured parameters entirely'
  );

  console.log('✅ apply_patch freeform-only tool schema regression passed');
}

main().catch((err) => {
  console.error('❌ apply_patch freeform tool schema passthrough regression failed:', err);
  process.exit(1);
});
