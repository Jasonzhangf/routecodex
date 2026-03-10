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
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'req_outbound',
    'req_outbound_stage2_format_build',
    'index.js'
  )
).href;
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

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

function clearNativeEnv() {
  for (const key of [
    'ROUTECODEX_LLMS_ROUTER_NATIVE_PATH',
    'RCC_LLMS_ROUTER_NATIVE_PATH',
    'ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE',
    'RCC_LLMS_ROUTER_NATIVE_DISABLE'
  ]) {
    delete process.env[key];
  }
}

function workspaceNativeCandidatePaths() {
  const rustCore = path.join(repoRoot, 'rust-core', 'target');
  return [
    path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node'),
    path.join(rustCore, 'release', 'router_hotpath_napi.node'),
    path.join(rustCore, 'release', 'librouter_hotpath_napi.dylib'),
    path.join(rustCore, 'release', 'librouter_hotpath_napi.so'),
    path.join(rustCore, 'release', 'router_hotpath_napi.dll'),
    path.join(rustCore, 'debug', 'router_hotpath_napi.node'),
    path.join(rustCore, 'debug', 'librouter_hotpath_napi.dylib'),
    path.join(rustCore, 'debug', 'librouter_hotpath_napi.so'),
    path.join(rustCore, 'debug', 'router_hotpath_napi.dll')
  ];
}

async function withWorkspaceNativeMasked(fn) {
  const backups = [];
  for (const candidate of workspaceNativeCandidatePaths()) {
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const backupPath = `${candidate}.bak.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    await fs.rename(candidate, backupPath);
    backups.push({ candidate, backupPath });
  }

  try {
    await fn();
  } finally {
    for (const item of backups.reverse()) {
      await fs.rename(item.backupPath, item.candidate);
    }
  }
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-hub-req-outbound-format-build-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeAdapterContext() {
  return {
    requestId: 'req_outbound_format_build_cov',
    providerProtocol: 'openai-chat'
  };
}

async function runBuild(runReqOutboundStage2FormatBuild) {
  return runReqOutboundStage2FormatBuild({
    formatEnvelope: {
      protocol: 'openai-chat',
      direction: 'request',
      payload: {
        keep: true,
        __rcc_private_root: 1,
        nested: {
          ok: true,
          __rcc_private_nested: 2
        },
        nullable: null,
        list: [
          { __rcc_private_item: 3, value: 'x' },
          null,
          { value: 'y' }
        ]
      }
    },
    adapterContext: makeAdapterContext(),
    formatAdapter: { buildRequest: async () => ({}) },
    stageRecorder: {
      record() {
        return undefined;
      }
    }
  });
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  try {
    clearNativeEnv();
    {
      const mod = await importFresh('native-ok');
      const { runReqOutboundStage2FormatBuild } = mod;
      assert.equal(typeof runReqOutboundStage2FormatBuild, 'function');

      const payload = await runBuild(runReqOutboundStage2FormatBuild);
      assert.equal(payload.keep, true);
      assert.equal(payload.__rcc_private_root, undefined);
      assert.equal(payload.nested.__rcc_private_nested, undefined);
      assert.equal(payload.nullable, null);
      assert.equal(payload.list[0].__rcc_private_item, undefined);
      assert.equal(payload.list[1], null);
      assert.equal(payload.list[0].value, 'x');
    }

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.stripPrivateFieldsJson = () => JSON.stringify([]);`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-invalid-payload');
        await assert.rejects(
          async () => runBuild(mod.runReqOutboundStage2FormatBuild),
          /native stripPrivateFieldsJson is required but unavailable/i
        );
      }
    );

    await withTempNativeModule(
      `const real = require(${JSON.stringify(nativeNodePath)});
module.exports = { ...real };
module.exports.buildFormatRequestJson = () => JSON.stringify({ payload: [] });`,
      async (modulePath) => {
        clearNativeEnv();
        setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
        const mod = await importFresh('native-invalid-build-output');
        await assert.rejects(
          async () => runBuild(mod.runReqOutboundStage2FormatBuild),
          /native buildFormatRequestJson is required but unavailable/i
        );
      }
    );

    console.log('✅ coverage-hub-req-outbound-format-build passed');
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
    if (prevNativeDisable === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-outbound-format-build failed:', error);
  process.exit(1);
});
