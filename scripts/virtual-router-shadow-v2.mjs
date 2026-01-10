#!/usr/bin/env node

/**
 * Virtual Router v1/v2 shadow comparison script.
 *
 * 构造一个简化的 userConfig + 临时 provider-root：
 * - 使用 buildVirtualRouterInputFromUserConfig 生成 v1 视图；
 * - 使用 buildVirtualRouterInputV2 生成 v2 视图；
 * 然后比较 providers / routing 结构是否一致。
 *
 * 依赖前提：dist/ 已通过 `npm run build` 生成。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // 尝试从 dist 导入构建函数
  let buildVirtualRouterInputFromUserConfig;
  let buildVirtualRouterInputV2;
  try {
    // eslint-disable-next-line import/no-dynamic-require
    ({ buildVirtualRouterInputFromUserConfig } = await import(
      path.join(__dirname, '../dist/config/virtual-router-types.js')
    ));
    // eslint-disable-next-line import/no-dynamic-require
    ({ buildVirtualRouterInputV2 } = await import(
      path.join(__dirname, '../dist/config/virtual-router-builder.js')
    ));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[virtual-router-shadow-v2] Failed to load dist modules. Please run `npm run build` first.',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
    return;
  }

  // 构造简化 userConfig（v1 风格：virtualrouter.providers + routing）
  const userConfig = {
    virtualrouter: {
      providers: {
        demo: {
          type: 'mock-provider',
          baseURL: 'https://demo.example.com',
          models: {
            'mock-1': { maxTokens: 1024 }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'primary',
            targets: ['demo.mock-1']
          }
        ]
      }
    }
  };

  // 构造临时 provider-root，并写入 v2 风格配置
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vr-shadow-v2-'));
  const providerDir = path.join(tempRoot, 'demo');
  await fs.mkdir(providerDir, { recursive: true });
  const v2Payload = {
    version: '2.0.0',
    providerId: 'demo',
    provider: userConfig.virtualrouter.providers.demo
  };
  await fs.writeFile(
    path.join(providerDir, 'config.v2.json'),
    `${JSON.stringify(v2Payload, null, 2)}\n`,
    'utf8'
  );

  // 构建 v1/v2 视图
  const v1Input = buildVirtualRouterInputFromUserConfig(userConfig);
  const v2Input = await buildVirtualRouterInputV2(userConfig, tempRoot);

  // 比较 providers
  const v1Providers = Object.keys(v1Input.providers || {});
  const v2Providers = Object.keys(v2Input.providers || {});

  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2] v1 providers:', v1Providers);
  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2] v2 providers:', v2Providers);

  const providersEqual =
    v1Providers.length === v2Providers.length &&
    v1Providers.every((id) => v2Providers.includes(id)) &&
    v1Providers.every((id) => {
      const v1 = v1Input.providers[id];
      const v2 = v2Input.providers[id];
      return JSON.stringify(v1) === JSON.stringify(v2);
    });

  // 比较 routing
  const routingEqual = JSON.stringify(v1Input.routing) === JSON.stringify(v2Input.routing);

  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2] providers equal:', providersEqual);
  // eslint-disable-next-line no-console
  console.log('[virtual-router-shadow-v2] routing equal:', routingEqual);

  if (!providersEqual || !routingEqual) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[virtual-router-shadow-v2] failed:', error);
  process.exit(1);
});
