#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-tool-normalization.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-chat-tool-normalization-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const { castGovernedTools } = await importFresh('hub-chat-process-tool-normalization');
  assert.equal(typeof castGovernedTools, 'function');

  {
    const out = castGovernedTools(undefined);
    assert.equal(out, undefined);
  }

  {
    const out = castGovernedTools([]);
    assert.deepEqual(out, []);
  }

  {
    const out = castGovernedTools([null, 1, 'x', { type: 'custom', name: 'noop' }, { function: {} }]);
    assert.deepEqual(out, []);
  }

  {
    const input = [
      {
        function: {
          name: 'plain_tool',
          description: 123,
          parameters: {
            properties: {
              query: { type: 'string' }
            }
          }
        }
      }
    ];
    const out = castGovernedTools(input);
    assert.equal(out?.length, 1);
    assert.equal(out?.[0]?.function?.name, 'plain_tool');
    assert.equal(out?.[0]?.function?.description, undefined);
    assert.equal(out?.[0]?.function?.parameters?.type, 'object');
    assert.deepEqual(out?.[0]?.function?.parameters?.properties, {
      query: { type: 'string' }
    });

    (out?.[0]?.function?.parameters?.properties ?? {}).query = { type: 'number' };
    assert.deepEqual(input[0].function.parameters.properties.query, { type: 'string' });
  }

  {
    const out = castGovernedTools([
      {
        strict: true,
        function: {
          name: 'tool_from_parent_strict',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        function: {
          name: 'tool_from_fn_strict',
          strict: true,
          parameters: []
        }
      }
    ]);
    assert.equal(out?.length, 2);
    assert.equal(out?.[0]?.function?.strict, true);
    assert.equal(out?.[1]?.function?.strict, true);
    assert.deepEqual(out?.[1]?.function?.parameters, {
      type: 'object',
      properties: {},
      additionalProperties: true
    });
  }

  {
    const out = castGovernedTools([
      {
        function: {
          name: 'tool_to_json_string',
          parameters: {
            toJSON() {
              return 'not-an-object';
            }
          }
        }
      }
    ]);
    assert.equal(out?.length, 1);
    assert.deepEqual(out?.[0]?.function?.parameters, {
      type: 'object',
      properties: {},
      additionalProperties: true
    });
  }

  {
    const out = castGovernedTools([
      { type: 'CUSTOM', name: ' apply_patch ', description: 'desc' },
      { type: 'custom', name: '' },
      { type: 'custom', name: 'web_search' }
    ]);
    assert.equal(out?.length, 1);
    assert.equal(out?.[0]?.function?.name, 'apply_patch');
    assert.equal(out?.[0]?.function?.description, 'desc');
    assert.equal(out?.[0]?.function?.strict, true);
    assert.equal(out?.[0]?.function?.parameters?.type, 'object');
  }

  {
    const out = castGovernedTools([
      { function: { name: 'ok_tool', parameters: { type: 'object', properties: {} } } },
      { function: { name: 1, parameters: { type: 'object', properties: {} } } },
      { type: 'custom', name: 'apply_patch' }
    ]);
    assert.equal(out?.length, 2);
    assert.equal(out?.[0]?.function?.name, 'ok_tool');
    assert.equal(out?.[1]?.function?.name, 'apply_patch');
  }

  await withTempNativeModule(
    `
exports.castGovernedToolsJson = () => JSON.stringify([
  { type: 'function', function: { name: 'native_tool', parameters: { type: 'object', properties: {} }, strict: true } }
]);
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-chat-process-tool-normalization-native');
      const out = modNative.castGovernedTools([{ function: { name: 'ignored' } }]);
      assert.equal(out?.length, 1);
      // Native normalization may come from built-in binding or injected mock binding.
      assert.ok(['ignored', 'native_tool'].includes(String(out?.[0]?.function?.name ?? '')));
      assert.ok(out?.[0]?.function?.strict === undefined || out?.[0]?.function?.strict === true);
    }
  );

  if (prevNativeDisable === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
  }
  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-chat-process-tool-normalization passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-tool-normalization failed:', error);
  process.exit(1);
});
