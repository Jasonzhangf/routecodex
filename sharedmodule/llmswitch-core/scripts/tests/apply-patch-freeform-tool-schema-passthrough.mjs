#!/usr/bin/env node
/**
 * Regression: apply_patch tool surface is freeform-only.
 *
 * - MUST NOT enforce/emit structured `changes[]` schema.
 * - MUST accept missing parameters from client and fill a minimal freeform schema.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function loadToolMapping() {
  return import(pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'shared', 'tool-mapping.js')).href);
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

function hasFreeformPatchSchema(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  const props = parameters.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  return Object.prototype.hasOwnProperty.call(props, 'patch') || Object.prototype.hasOwnProperty.call(props, 'input');
}

async function main() {
  const { bridgeToolToChatDefinition } = await loadToolMapping();

  const rawTool = makeClientApplyPatchTool();

  const mapped = bridgeToolToChatDefinition(rawTool);
  assert.ok(mapped, 'expected tool mapping to produce a definition');
  assert.ok(
    !hasStructuredChangesSchema(mapped.function?.parameters),
    'expected apply_patch schema to NOT include properties.changes'
  );
  assert.ok(
    hasFreeformPatchSchema(mapped.function?.parameters),
    'expected apply_patch schema to include patch/input for freeform patch text'
  );

  console.log('✅ apply_patch freeform-only tool schema regression passed');
}

main().catch((err) => {
  console.error('❌ apply_patch freeform tool schema passthrough regression failed:', err);
  process.exit(1);
});
