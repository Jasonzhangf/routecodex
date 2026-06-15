#!/usr/bin/env node
/**
 * Regression: apply_patch tool surface is freeform-only.
 *
 * - MUST NOT enforce/emit structured `changes[]` schema.
 * - MUST NOT resurrect legacy `filePath` / structured patch schema at shared tool-mapping layer.
 * - Shared tool-mapping may omit parameters entirely; provider/runtime owners fill protocol-specific shape later.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const FEATURE_ID_APPLY_PATCH_FREEFORM_CONTRACT = 'feature_id: tool.apply_patch_freeform_contract';

async function loadToolMapping() {
  const distPath = path.join(repoRoot, 'dist', 'conversion', 'shared', 'tool-mapping.js');
  if (fs.existsSync(distPath)) {
    return import(pathToFileURL(distPath).href);
  }
  return import(pathToFileURL(path.join(repoRoot, 'src', 'conversion', 'shared', 'tool-mapping.ts')).href);
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
  const { mapBridgeToolsToChat } = await loadToolMapping();

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
