#!/usr/bin/env node
/**
 * Gemini outbound tool schema sanitization invariant
 *
 * Antigravity/Gemini backends can return MALFORMED_FUNCTION_CALL when tool parameter
 * schemas include JSON Schema combinators like oneOf/anyOf/allOf (and sometimes strict
 * keys like required/additionalProperties).
 *
 * llmswitch-core must sanitize these fields before sending to Gemini.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const geminiToolsMod = await import(path.join(projectRoot, 'dist', 'conversion', 'shared', 'gemini-tool-utils.js'));

const { buildGeminiToolsFromBridge } = geminiToolsMod;

function containsForbiddenKeys(value) {
  const text = JSON.stringify(value);
  return (
    text.includes('"oneOf"') ||
    text.includes('"anyOf"') ||
    text.includes('"allOf"') ||
    text.includes('"additionalProperties"')
  );
}

async function main() {
  const defs = [
    {
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Run a shell command.',
        parameters: {
          type: 'object',
          required: ['cmd'],
          additionalProperties: false,
          properties: {
            cmd: {
              description: 'Shell command to execute.',
              oneOf: [{ type: 'string' }, { type: 'object', properties: { script: { type: 'string' } } }]
            },
            workdir: {
              description: 'Working directory.',
              anyOf: [{ type: 'string' }, { type: 'null' }]
            }
          }
        }
      }
    }
  ];

  const tools = buildGeminiToolsFromBridge(defs);
  assert.ok(Array.isArray(tools) && tools.length === 1, 'Expected exactly 1 Gemini tool');

  const decl = tools?.[0]?.functionDeclarations?.[0];
  assert.ok(decl && typeof decl === 'object', 'Expected functionDeclarations[0]');
  assert.strictEqual(decl.name, 'exec_command', 'Tool name must match');

  assert.ok(!containsForbiddenKeys(tools), 'Gemini tools must not contain combinators or additionalProperties');

  // Do not enforce hard required keys for Gemini: the model may emit either alias (cmd/command),
  // and a required mismatch surfaces as MALFORMED_FUNCTION_CALL (empty reply).
  assert.ok(
    decl.parameters?.required === undefined ||
      (Array.isArray(decl.parameters?.required) && decl.parameters.required.length === 0),
    'exec_command must not enforce required keys for Gemini'
  );

  const cmdSchema = decl.parameters?.properties?.cmd;
  const commandSchema = decl.parameters?.properties?.command;
  assert.ok(cmdSchema && typeof cmdSchema === 'object', 'cmd schema must exist');
  assert.ok(commandSchema && typeof commandSchema === 'object', 'command schema must exist');
  assert.strictEqual(cmdSchema.type, 'string', 'oneOf should be simplified to a single compatible schema');
  assert.strictEqual(commandSchema.type, 'string', 'oneOf should be simplified to a single compatible schema');

  console.log('✅ Gemini outbound tool schema sanitization invariant passed');
}

main().catch((err) => {
  console.error('❌ gemini-tool-schema-sanitize test failed:', err);
  process.exit(1);
});
