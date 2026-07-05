#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { augmentOpenAITools, augmentAnthropicTools, buildSystemToolGuidance } = await import('../../dist/guidance/index.js');

  // OpenAI tool shape augmentation.
  {
    const input = [
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'desc',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'patch',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: { name: 'update_plan', description: 'plan', parameters: { type: 'object', properties: {} } }
      },
      {
        type: 'function',
        function: { name: 'view_image', description: 'img', parameters: { type: 'object', properties: {} } }
      },
      {
        type: 'function',
        function: { name: 'unknown_tool', description: 'noop', parameters: { type: 'object', properties: {} } }
      }
    ];

    const out = augmentOpenAITools(input);
    assert.ok(Array.isArray(out) && out.length === input.length);

    const shell = out.find((t) => t?.function?.name === 'shell')?.function;
    assert.ok(shell && typeof shell.description === 'string' && shell.description.includes('[Codex Shell Guidance]'));
    assert.ok(shell.parameters?.properties?.command?.oneOf, 'shell.parameters.properties.command.oneOf must exist');
    assert.equal(shell.parameters.additionalProperties, false);

    const ap = out.find((t) => t?.function?.name === 'apply_patch')?.function;
    assert.ok(ap && typeof ap.description === 'string' && ap.description === 'patch');
    assert.equal(ap.parameters.properties.patch, undefined);
    assert.equal(ap.parameters.properties.input, undefined);
  }

  // Anthropic tool shape augmentation.
  {
    const input = [
      { name: 'apply_patch', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'shell', description: 'y', input_schema: { type: 'object', properties: {} } },
      { name: 'update_plan', description: 'z', input_schema: { type: 'object', properties: {} } }
    ];
    const out = augmentAnthropicTools(input);
    const ap = out.find((t) => t?.name === 'apply_patch');
    assert.ok(ap && typeof ap.description === 'string' && ap.description === 'x');
    assert.equal(ap.input_schema?.properties?.patch, undefined);
    assert.equal(ap.input_schema?.properties?.input, undefined);
  }

  // System tool guidance string (used by hosts/providers).
  {
    const text = buildSystemToolGuidance();
    assert.ok(typeof text === 'string' && text.includes('tool_calls'), 'system tool guidance must mention tool_calls');
    assert.ok(!text.includes('apply_patch'), 'generic system guidance must not own apply_patch policy');
  }

  console.log('✅ coverage-guidance-augment passed');
}

main().catch((e) => {
  console.error('❌ coverage-guidance-augment failed:', e);
  process.exit(1);
});
