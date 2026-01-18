#!/usr/bin/env node

/**
 * Virtual Router v1/v2 shadow comparison against real user config.
 *
 * - 读取当前用户配置（~/.routecodex/config.json 或 env 指定路径）；
 * - 使用 buildVirtualRouterInputFromUserConfig 生成 v1 视图；
 * - 使用 buildVirtualRouterInputV2 生成 v2 视图（从 ~/.routecodex/provider 加载 provider v2）；
 * - 对比 providers / routing 结构并打印差异摘要。
 *
 * 依赖前提：dist/ 已通过 `npm run build` 或等价 tsc 编译生成。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeErrorSampleJson } from './lib/errorsamples.mjs';

async function resolveConfigPath() {
  const explicit = process.env.ROUTECODEX_CONFIG || process.env.RCC_CONFIG;
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  return path.join(os.homedir(), '.routecodex', 'config.json');
}

async function loadUserConfig() {
  const configPath = await resolveConfigPath();
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

function normalizeKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(Object.entries(obj).filter(([k]) => typeof k === 'string'));
}

function diffKeys(a, b) {
  const aKeys = new Set(Object.keys(a));
  const bKeys = new Set(Object.keys(b));
  const onlyA = [...aKeys].filter((k) => !bKeys.has(k));
  const onlyB = [...bKeys].filter((k) => !aKeys.has(k));
  return { onlyA, onlyB };
}

function redactSecrets(value) {
  const secretKeyRe = /key|token|secret|password|authorization/i;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (secretKeyRe.test(k)) out[k] = '[REDACTED]';
    else out[k] = redactSecrets(v);
  }
  return out;
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let buildVirtualRouterInputFromUserConfig;
  let buildVirtualRouterInputV2;
  try {
    ({ buildVirtualRouterInputFromUserConfig } = await import(
      path.join(__dirname, '../dist/config/virtual-router-types.js')
    ));
    ({ buildVirtualRouterInputV2 } = await import(
      path.join(__dirname, '../dist/config/virtual-router-builder.js')
    ));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[virtual-router-shadow-v2-real] Failed to load dist modules. Please run `npm run build` or tsc first.',
      error instanceof Error ? error.message : String(error)
    );
    try {
      const file = await writeErrorSampleJson({
        group: 'virtual-router-shadow-v2-real',
        kind: 'fatal',
        payload: {
          kind: 'virtual-router-shadow-v2-real-fatal',
          stamp: new Date().toISOString(),
          error: String(error instanceof Error ? error.stack || error.message : String(error))
        }
      });
      // eslint-disable-next-line no-console
      console.error(`[virtual-router-shadow-v2-real] wrote errorsample: ${file}`);
    } catch {}
    process.exitCode = 1;
    return;
  }

  let userConfig;
  try {
    userConfig = await loadUserConfig();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[virtual-router-shadow-v2-real] Failed to load user config:',
      error instanceof Error ? error.message : String(error)
    );
    try {
      const file = await writeErrorSampleJson({
        group: 'virtual-router-shadow-v2-real',
        kind: 'fatal',
        payload: {
          kind: 'virtual-router-shadow-v2-real-fatal',
          stamp: new Date().toISOString(),
          error: String(error instanceof Error ? error.stack || error.message : String(error))
        }
      });
      // eslint-disable-next-line no-console
      console.error(`[virtual-router-shadow-v2-real] wrote errorsample: ${file}`);
    } catch {}
    process.exitCode = 1;
    return;
  }

  const v1Input = buildVirtualRouterInputFromUserConfig(userConfig);
  const v2Input = await buildVirtualRouterInputV2(userConfig);

  const v1Providers = normalizeKeys(v1Input.providers || {});
  const v2Providers = normalizeKeys(v2Input.providers || {});

  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2-real] v1 provider keys:', Object.keys(v1Providers));
  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2-real] v2 provider keys:', Object.keys(v2Providers));

  const providerKeyDiff = diffKeys(v1Providers, v2Providers);
  const providersEqual =
    providerKeyDiff.onlyA.length === 0 && providerKeyDiff.onlyB.length === 0;

  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2-real] providers key diff:', providerKeyDiff);

  let providerPayloadEqual = providersEqual;
  if (providersEqual) {
    for (const key of Object.keys(v1Providers)) {
      const a = v1Providers[key];
      const b = v2Providers[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        providerPayloadEqual = false;
        // eslint-disable-next-line no-console
        console.log(
          `[virtual-router-shadow-v2-real] provider payload mismatch for "${key}" (showing v1/v2 JSON):`
        );
        // eslint-disable-next-line no-console
        console.log('v1:', JSON.stringify(a, null, 2));
        // eslint-disable-next-line no-console
        console.log('v2:', JSON.stringify(b, null, 2));
        break;
      }
    }
  }

  const routingEqual = JSON.stringify(v1Input.routing || {}) === JSON.stringify(v2Input.routing || {});

  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2-real] providers keys equal:', providersEqual);
  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2-real] providers payload equal:', providerPayloadEqual);
  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2-real] routing equal:', routingEqual);

  if (!providersEqual || !providerPayloadEqual || !routingEqual) {
    try {
      const file = await writeErrorSampleJson({
        group: 'virtual-router-shadow-v2-real',
        kind: 'diff',
        payload: {
          kind: 'virtual-router-shadow-v2-real-diff',
          stamp: new Date().toISOString(),
          configPath: await resolveConfigPath(),
          providerKeyDiff,
          providersEqual,
          providerPayloadEqual,
          routingEqual,
          v1ProvidersKeys: Object.keys(v1Providers),
          v2ProvidersKeys: Object.keys(v2Providers),
          v1Routing: redactSecrets(v1Input.routing || {}),
          v2Routing: redactSecrets(v2Input.routing || {}),
          v1Providers: redactSecrets(v1Providers),
          v2Providers: redactSecrets(v2Providers)
        }
      });
      // eslint-disable-next-line no-console
      console.error(`[virtual-router-shadow-v2-real] wrote errorsample: ${file}`);
    } catch {}
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[virtual-router-shadow-v2-real] failed:', error);
  void writeErrorSampleJson({
    group: 'virtual-router-shadow-v2-real',
    kind: 'fatal',
    payload: {
      kind: 'virtual-router-shadow-v2-real-fatal',
      stamp: new Date().toISOString(),
      error: String(error instanceof Error ? error.stack || error.message : String(error))
    }
  }).catch(() => {});
  process.exit(1);
});
