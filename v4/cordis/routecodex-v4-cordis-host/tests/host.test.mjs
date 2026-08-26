import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, FiberState } from 'cordis';
import {
  CordisNodeHost,
  CordisHostError,
  createCordisPluginFactory,
  createNodePlugin,
} from '../src/index.mjs';

test('mounts real Cordis fibers and disposes in reverse order', async () => {
  const events = [];
  const plugin = (id) => createNodePlugin(id, (ctx) => {
    ctx.effect(() => () => events.push(`${id}:dispose`));
    events.push(`${id}:active`);
  });
  const host = new CordisNodeHost({
    nodeId: 'node-a',
    descriptor: { roleId: 'request_chat_process' },
    services: ['typedHandleRegistry'],
  });
  await host.mount([plugin('a'), plugin('b')]);
  assert.equal(host.fibers.length, 2);
  assert.equal(host.fibers.every(({ fiber }) => fiber.state === FiberState.ACTIVE), true);
  await host.dispose();
  assert.deepEqual(events, ['a:active', 'b:active', 'b:dispose', 'a:dispose']);
  await host.dispose();
  assert.deepEqual(events, ['a:active', 'b:active', 'b:dispose', 'a:dispose']);
});

test('pending dependency is rejected and mounted fibers roll back', async () => {
  const host = new CordisNodeHost({
    nodeId: 'node-b',
    descriptor: { roleId: 'request_chat_process' },
  });
  await assert.rejects(
    host.mount([
      createNodePlugin(
        'pending',
        Object.assign(
          () => () => {},
          { inject: ['missingService'] },
        ),
      ),
    ]),
    (error) => error instanceof CordisHostError && error.code === 'plugin_not_active',
  );
  assert.equal(host.fibers.length, 0);
});

test('failing in-flight fiber is disposed before mount rejects', async () => {
  const events = [];
  const host = new CordisNodeHost({
    nodeId: 'node-failed',
    descriptor: { roleId: 'request_chat_process' },
  });
  await assert.rejects(
    host.mount([
      createNodePlugin('failing', (ctx) => {
        ctx.effect(() => () => events.push('failing:dispose'));
        throw new Error('mount failed after effect start');
      }),
    ]),
    /mount failed after effect start/,
  );
  assert.deepEqual(events, ['failing:dispose']);
  assert.equal(host.fibers.length, 0);
});

test('node context is real Cordis Context and service names are isolated', () => {
  const host = new CordisNodeHost({
    nodeId: 'node-c',
    descriptor: { roleId: 'request_chat_process' },
    services: ['typedHandleRegistry'],
  });
  assert.equal(Context.is(host.context), true);
  assert.equal(host.context.root !== host.context, true);
});

test('canonical catalog factory mounts generic Cordis fibers and disposes them in reverse order', async () => {
  const events = [];
  const catalog = Object.freeze({
    entries: Object.freeze([
      Object.freeze({
        plugin_id: 'v4.request.first',
        version: '1.0.0',
        owner: 'test',
        artifact_hash: 'sha256:first',
        contract_hash: 'sha256:contract-first',
        supported_node_roles: ['request_chat_process'],
        services_provided: [],
        services_injected: [],
        resources_read: [],
        resources_written: [],
        required_tests: ['factory'],
      }),
      Object.freeze({
        plugin_id: 'v4.request.second',
        version: '1.0.0',
        owner: 'test',
        artifact_hash: 'sha256:second',
        contract_hash: 'sha256:contract-second',
        supported_node_roles: ['request_chat_process'],
        services_provided: [],
        services_injected: [],
        resources_read: [],
        resources_written: [],
        required_tests: ['factory'],
      }),
    ]),
  });
  const factory = createCordisPluginFactory({
    catalog,
    implementations: new Map([
      ['v4.request.first@1.0.0+sha256:first', (ctx) => {
        ctx.effect(() => () => events.push('first:dispose'));
        events.push('first:active');
      }],
      ['v4.request.second@1.0.0+sha256:second', (ctx) => {
        ctx.effect(() => () => events.push('second:dispose'));
        events.push('second:active');
      }],
    ]),
  });
  const host = new CordisNodeHost({
    nodeId: 'node-factory',
    descriptor: { roleId: 'request_chat_process' },
  });

  await host.mount(factory.createPlugins(catalog.entries));
  assert.equal(host.fibers.length, 2);
  await host.dispose();
  assert.deepEqual(events, [
    'first:active',
    'second:active',
    'second:dispose',
    'first:dispose',
  ]);
});

test('canonical catalog factory rejects an implementation missing from the catalog', () => {
  assert.throws(
    () => createCordisPluginFactory({
      catalog: { entries: [] },
      implementations: new Map([
        ['v4.request.unknown@1.0.0+sha256:unknown', () => {}],
      ]),
    }),
    (error) => error instanceof CordisHostError && error.code === 'catalog_implementation_mismatch',
  );
});
