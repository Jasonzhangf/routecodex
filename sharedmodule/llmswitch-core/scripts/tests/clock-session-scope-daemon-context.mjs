#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function createVirtualRouterBootstrapInput() {
  return {
    virtualrouter: {
      providers: {
        iflow: {
          type: 'openai',
          endpoint: 'http://localhost',
          auth: {
            type: 'apikey',
            keys: { key1: { value: 'dummy' } }
          }
        }
      },
      routing: {
        default: [
          {
            id: 'default:single',
            priority: 100,
            mode: 'priority',
            targets: ['iflow.key1.kimi-k2.5']
          }
        ]
      },
      classifier: {}
    }
  };
}

async function main() {
  const { HubPipeline, __unsafeBuildAdapterContextForTest } = await import(path.join(projectRoot, 'dist', 'conversion', 'hub', 'pipeline', 'hub-pipeline.js'));
  const { bootstrapVirtualRouterConfig } = await import(path.join(projectRoot, 'dist', 'router', 'virtual-router', 'bootstrap.js'));
  const { resolveClockSessionScope } = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'session-scope.js'));

  const { config: virtualRouter } = bootstrapVirtualRouterConfig(createVirtualRouterBootstrapInput());
  const hubPipeline = new HubPipeline({ virtualRouter });
  assert.equal(typeof __unsafeBuildAdapterContextForTest, 'function', '__unsafeBuildAdapterContextForTest should be callable');

  const adapterContext = __unsafeBuildAdapterContextForTest({
    id: 'req_clock_daemon_context',
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: { model: 'kimi-k2.5', input: [{ role: 'user', content: 'hi' }] },
    metadata: {
      sessionId: 'session_clock_1',
      conversationId: 'conv_clock_1',
      clockDaemonId: 'daemon_clock_1',
      tmuxSessionId: 'tmux_clock_1',
      clientType: 'codex',
      cwd: '/tmp/clock-workdir'
    },
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    stream: false
  });

  assert.equal(adapterContext.clockDaemonId, 'daemon_clock_1');
  assert.equal(adapterContext.tmuxSessionId, 'tmux_clock_1');
  assert.equal(adapterContext.clientType, 'codex');
  assert.equal(adapterContext.cwd, '/tmp/clock-workdir');
  assert.equal(resolveClockSessionScope(adapterContext, adapterContext.__rt ?? null), 'tmux:tmux_clock_1');

  const adapterContextSnakeCase = __unsafeBuildAdapterContextForTest({
    id: 'req_clock_daemon_context_snake',
    endpoint: '/v1/responses',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    payload: { model: 'kimi-k2.5', input: [{ role: 'user', content: 'hi' }] },
    metadata: {
      sessionId: 'session_clock_2',
      clockDaemonId: 'daemon_clock_2'
    },
    processMode: 'chat',
    direction: 'request',
    stage: 'inbound',
    stream: false
  });

  assert.equal(adapterContextSnakeCase.clockDaemonId, 'daemon_clock_2');
  assert.equal(
    resolveClockSessionScope(adapterContextSnakeCase, adapterContextSnakeCase.__rt ?? null),
    'session_clock_2'
  );

  assert.equal(resolveClockSessionScope({}, { clockClientDaemonId: 'daemon_clock_rt' }), null);

  hubPipeline.dispose();
  console.log('✅ clock session scope daemon context propagation passed');
}

main().catch((error) => {
  console.error('❌ clock session scope daemon context propagation failed', error);
  process.exit(1);
});
