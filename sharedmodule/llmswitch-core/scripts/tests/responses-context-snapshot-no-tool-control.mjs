#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function main() {
  const mod = await import(
    path.join(projectRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js')
  );

  const context = mod.captureResponsesContext({
    model: 'gpt-5.4',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tool_choice: 'required',
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    store: true,
    stream: true,
    response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
    service_tier: 'flex',
    truncation: 'auto',
    metadata: { foo: 'bar', extraFields: { should_drop: true } }
  });

  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'toolChoice'),
    false,
    'responses context snapshot should not carry toolChoice control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'parallelToolCalls'),
    false,
    'responses context snapshot should not carry parallelToolCalls control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'responseFormat'),
    false,
    'responses context snapshot should not carry responseFormat control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'serviceTier'),
    false,
    'responses context snapshot should not carry serviceTier control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'truncation'),
    false,
    'responses context snapshot should not carry truncation control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'include'),
    false,
    'responses context snapshot should not carry include control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'store'),
    false,
    'responses context snapshot should not carry store control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, 'stream'),
    false,
    'responses context snapshot should not carry stream control field'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context.metadata ?? {}, 'extraFields'),
    false,
    'responses context metadata should not preserve host-only extraFields'
  );

  console.log('✅ responses context snapshot no-tool-control regression passed');
}

main().catch((error) => {
  console.error('❌ responses context snapshot no-tool-control regression failed:', error);
  process.exit(1);
});
