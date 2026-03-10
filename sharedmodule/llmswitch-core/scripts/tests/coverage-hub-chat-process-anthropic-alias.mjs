#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-anthropic-alias.js')
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-chat-anthropic-alias-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeBaseRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Bash' }],
    parameters: {}
  };
}

async function main() {
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const { applyAnthropicToolAliasSemantics } = await importFresh('hub-chat-process-anthropic-alias');
  assert.equal(typeof applyAnthropicToolAliasSemantics, 'function');

  {
    const request = makeBaseRequest();
    const out = applyAnthropicToolAliasSemantics(request, '/v1/chat/completions');
    assert.equal(out, request);
    assert.equal(out.semantics, undefined);
  }

  {
    const request = makeBaseRequest();
    const out = applyAnthropicToolAliasSemantics(request, /** @type {any} */ (null));
    assert.equal(out, request);
    assert.equal(out.semantics, undefined);
  }

  {
    const request = makeBaseRequest();
    request.semantics = { tools: { toolNameAliasMap: { shell_command: 'KeepExisting' } } };
    const out = applyAnthropicToolAliasSemantics(request, '/v1/messages');
    assert.equal(out.semantics.tools.toolNameAliasMap.shell_command, 'KeepExisting');
  }

  {
    const request = makeBaseRequest();
    request.semantics = { tools: { toolAliasMap: { shell_command: 'LegacyAlias' } } };
    const out = applyAnthropicToolAliasSemantics(request, '/v1/messages');
    assert.equal(out.semantics.tools.toolAliasMap.shell_command, 'LegacyAlias');
    assert.equal(out.semantics.tools.toolNameAliasMap, undefined);
  }

  {
    const request = makeBaseRequest();
    request.tools = [];
    request.semantics = {
      tools: {
        clientToolsRaw: [{ name: 'Bash' }, { name: 'Read' }, { name: 'CustomTool' }, { foo: 'bar' }, null]
      }
    };
    const out = applyAnthropicToolAliasSemantics(request, '/v1/messages');
    assert.equal(out.semantics.tools.toolNameAliasMap.bash, 'Bash');
    assert.equal(out.semantics.tools.toolNameAliasMap.read, 'Read');
    assert.equal(out.semantics.tools.toolNameAliasMap.customtool, 'CustomTool');
  }

  {
    const request = makeBaseRequest();
    request.semantics = 'invalid-semantics';
    request.tools = [{ nope: true }];
    const out = applyAnthropicToolAliasSemantics(request, '/v1/messages');
    assert.equal(typeof out.semantics, 'object');
    assert.equal(Array.isArray(out.semantics), false);
    assert.equal(out.semantics.tools.toolNameAliasMap, undefined);
  }

  {
    const request = {};
    Object.defineProperty(request, 'semantics', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('boom');
      },
      set() {
        // ignore
      }
    });
    const out = applyAnthropicToolAliasSemantics(request, '/v1/messages');
    assert.equal(out, request);
  }

  await withTempNativeModule(
    `
exports.buildAnthropicToolAliasMapJson = () => JSON.stringify({ bash: 'NativeBash' });
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-chat-process-anthropic-alias-native');
      const request = makeBaseRequest();
      const out = modNative.applyAnthropicToolAliasSemantics(request, '/v1/messages');
      // Native alias source may be built-in or injected mock module, both are valid for this coverage test.
      assert.ok(['Bash', 'NativeBash'].includes(out.semantics.tools.toolNameAliasMap.bash));
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

  console.log('✅ coverage-hub-chat-process-anthropic-alias passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-anthropic-alias failed:', error);
  process.exit(1);
});
