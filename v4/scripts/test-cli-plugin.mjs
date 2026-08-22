#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(root, 'target/release/rccv4-plugin');

if (!fs.existsSync(binary)) {
  throw new Error(`CLI release artifact missing: ${binary}`);
}

function run(...args) {
  return execFileSync(binary, args, { cwd: root, encoding: 'utf8' }).trim();
}

assert.match(run('version'), /^rccv4-plugin version \S+ owner routecodex-v4-standard-plugins$/);

const plugins = JSON.parse(run('list-plugins'));
assert.equal(plugins.length, 23);
assert.ok(plugins.includes('v4.std.protocol.wire_codec_proto'));

const descriptor = JSON.parse(run('describe-plugin', 'v4.std.protocol.wire_codec_proto'));
assert.equal(descriptor.plugin_id, 'v4.std.protocol.wire_codec_proto');
assert.equal(descriptor.node_id, 'V4ProviderReqCompat06Compat');

const resources = JSON.parse(run('list-resources'));
assert.ok(resources.some((entry) => entry.resource_id === 'v4.response.client_object'));

const permissions = JSON.parse(run('node-permissions', 'V4ServerRespOutbound06ClientFrame'));
assert.deepEqual(permissions.reads, ['v4.response.client_wire_payload']);
assert.deepEqual(permissions.writes, ['v4.response.client_object']);

const zeroPermissions = JSON.parse(run('node-permissions', 'V4HubReqInbound03Normalized'));
assert.deepEqual(zeroPermissions.reads, ['v4.request.normal_payload']);
assert.deepEqual(zeroPermissions.writes, []);

const surface = JSON.parse(run('surface'));
assert.ok(surface.reads.includes('v4.response.client_wire_payload'));
assert.ok(surface.writes.includes('v4.response.client_wire_payload'));

const categories = JSON.parse(run('categories'));
assert.equal(categories.length, 8);
assert.ok(categories.every((entry) => entry.count > 0));

const unknownPlugin = spawnSync(binary, ['describe-plugin', 'v4.std.unknown'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(unknownPlugin.status, 2);
assert.match(unknownPlugin.stderr, /unknown plugin id v4\.std\.unknown/);

const unknownNode = spawnSync(binary, ['node-permissions', 'V4NotARegisteredNode'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(unknownNode.status, 2);
assert.match(unknownNode.stderr, /has no standard permission surface/);

console.log('[v4 cli smoke] OK release artifact commands=7 negative=2');
