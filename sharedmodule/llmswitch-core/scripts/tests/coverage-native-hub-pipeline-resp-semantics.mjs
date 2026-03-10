#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-hub-pipeline-resp-semantics.js'
  )
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-native-resp-sem-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  await withTempNativeModule(
    `
exports.resolveAliasMapFromRespSemanticsJson = () => JSON.stringify({ bash: 'Bash' });
exports.resolveClientToolsRawFromRespSemanticsJson = () => JSON.stringify([{ type: 'function', name: 'exec_command' }]);
exports.extractSseWrapperErrorJson = () => JSON.stringify('wrapper failed');
exports.extractContextLengthDiagnosticsJson = () => JSON.stringify({ estimatedPromptTokens: 1234, maxContextTokens: 8192 });
exports.isContextLengthExceededSignalJson = () => JSON.stringify(true);
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', undefined);

      const mod = await importFresh('native-hub-pipeline-resp-semantics');

      const aliasMap = mod.resolveAliasMapFromRespSemanticsWithNative(
        {
          tools: {
            toolNameAliasMap: {
              shell_command: 'shell_command'
            }
          }
        },
        { fallback: 'fallback' }
      );
      assert.deepEqual(aliasMap, { bash: 'Bash' });

      const clientToolsRaw = mod.resolveClientToolsRawFromRespSemanticsWithNative(
        {
          tools: {
            clientToolsRaw: [{ type: 'function', name: 'read' }]
          }
        },
        [{ type: 'function', name: 'fallback' }]
      );
      assert.deepEqual(clientToolsRaw, [{ type: 'function', name: 'exec_command' }]);

      const wrapperError = mod.extractSseWrapperErrorWithNative(
        { mode: 'sse', error: 'wrapper failed' },
        undefined
      );
      assert.equal(wrapperError, 'wrapper failed');

      const diagnostics = mod.extractContextLengthDiagnosticsWithNative(
        {
          estimatedInputTokens: 1000,
          target: { maxContextTokens: 16000 }
        },
        {}
      );
      assert.deepEqual(diagnostics, { estimatedPromptTokens: 1234, maxContextTokens: 8192 });

      const exceeded = mod.isContextLengthExceededSignalWithNative(
        'context_length_exceeded',
        'context_length_exceeded',
        { errorData: { finish_reason: 'context_length_exceeded' } },
        false
      );
      assert.equal(exceeded, true);
    }
  );

  await withTempNativeModule(
    `
exports.resolveAliasMapFromRespSemanticsJson = () => '{invalid json';
exports.extractSseWrapperErrorJson = () => '[]';
exports.extractContextLengthDiagnosticsJson = () => '[]';
exports.isContextLengthExceededSignalJson = () => '"invalid"';
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', undefined);

      const mod = await importFresh('native-hub-pipeline-resp-semantics-fallback');

      assert.throws(
        () => mod.resolveAliasMapFromRespSemanticsWithNative({}, { shell_command: 'fallback' }),
        /native resolveAliasMapFromRespSemanticsJson is required but unavailable/
      );
      assert.throws(
        () =>
          mod.resolveClientToolsRawFromRespSemanticsWithNative({}, [{ type: 'function', name: 'fallback' }]),
        /native resolveClientToolsRawFromRespSemanticsJson is required but unavailable/
      );
      assert.throws(
        () => mod.extractSseWrapperErrorWithNative({}, undefined),
        /native extractSseWrapperErrorJson is required but unavailable/
      );
      assert.throws(
        () => mod.extractContextLengthDiagnosticsWithNative({}, {}),
        /native extractContextLengthDiagnosticsJson is required but unavailable/
      );
      assert.throws(
        () => mod.isContextLengthExceededSignalWithNative('', '', undefined, false),
        /native isContextLengthExceededSignalJson is required but unavailable/
      );
    }
  );

  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }
  if (prevRccNativePath === undefined) {
    delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.RCC_LLMS_ROUTER_NATIVE_PATH = prevRccNativePath;
  }

  console.log('✅ coverage-native-hub-pipeline-resp-semantics passed');
}

main().catch((error) => {
  console.error('❌ coverage-native-hub-pipeline-resp-semantics failed:', error);
  process.exit(1);
});
