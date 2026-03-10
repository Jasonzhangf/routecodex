#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const originalHome = process.env.HOME;
  const originalAuthDir = process.env.ROUTECODEX_AUTH_DIR;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-deepseek-home-'));
  const authDir = path.join(tempHome, '.routecodex', 'auth');
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, 'deepseek-account-1.json'), '{"access_token":"token-1"}\n', 'utf8');
  await fs.writeFile(path.join(authDir, 'deepseek-account-2.json'), '{"access_token":"token-2"}\n', 'utf8');

  process.env.HOME = tempHome;
  process.env.ROUTECODEX_AUTH_DIR = authDir;

  try {
    const { bootstrapVirtualRouterConfig } = await import('../../dist/router/virtual-router/bootstrap.js');

    const input = {
      virtualrouter: {
        providers: {
          'deepseek-web': {
            id: 'deepseek-web',
            type: 'openai',
            baseURL: 'https://chat.deepseek.com',
            compatibilityProfile: 'chat:deepseek-web',
            auth: {
              type: 'deepseek-account'
            },
            models: {
              'deepseek-chat': {}
            }
          }
        },
        routing: {
          default: [
            {
              id: 'default-primary',
              mode: 'round-robin',
              targets: ['deepseek-web.deepseek-chat']
            }
          ]
        }
      }
    };

    const { config, targetRuntime } = bootstrapVirtualRouterConfig(input);
    const targets = config.routing.default?.[0]?.targets ?? [];
    assert.deepEqual(
      targets,
      ['deepseek-web.1.deepseek-chat', 'deepseek-web.2.deepseek-chat'],
      'deepseek route should fan out to multiple token-file aliases'
    );
    assert.equal(
      targetRuntime['deepseek-web.1.deepseek-chat']?.auth?.tokenFile,
      path.join(authDir, 'deepseek-account-1.json')
    );
    assert.equal(
      targetRuntime['deepseek-web.2.deepseek-chat']?.auth?.tokenFile,
      path.join(authDir, 'deepseek-account-2.json')
    );
    console.log('[matrix:deepseek-bootstrap-multi-key-scan] ok');
  } finally {
    if (typeof originalHome === 'string') {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (typeof originalAuthDir === 'string') {
      process.env.ROUTECODEX_AUTH_DIR = originalAuthDir;
    } else {
      delete process.env.ROUTECODEX_AUTH_DIR;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

main();
