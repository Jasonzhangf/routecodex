#!/usr/bin/env node
import assert from 'node:assert/strict';
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
    'resp_outbound',
    'resp_outbound_stage1_client_remap',
    'chat-process-semantics-bridge.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-resp-outbound-chat-process-semantics-bridge');
  const resolveAliasMapFromSemantics = mod.resolveAliasMapFromSemantics;
  const normalizeAliasMap = mod.normalizeAliasMap;
  const resolveClientToolsRawFromSemantics = mod.resolveClientToolsRawFromSemantics;
  const resolveClientToolsRaw = mod.resolveClientToolsRaw;

  assert.equal(typeof resolveAliasMapFromSemantics, 'function');
  assert.equal(typeof normalizeAliasMap, 'function');
  assert.equal(typeof resolveClientToolsRawFromSemantics, 'function');
  assert.equal(typeof resolveClientToolsRaw, 'function');

  {
    assert.equal(resolveAliasMapFromSemantics(undefined), undefined);
    assert.equal(resolveAliasMapFromSemantics({}), undefined);
    assert.equal(resolveAliasMapFromSemantics({ tools: [] }), undefined);
    assert.equal(resolveAliasMapFromSemantics({ tools: {} }), undefined);
    assert.equal(resolveAliasMapFromSemantics({ tools: { toolNameAliasMap: {} } }), undefined);
  }

  {
    const alias = normalizeAliasMap({
      ' shell_command ': ' Bash ',
      read: 'Read',
      invalid_value: 1,
      '': 'empty',
      blank: '   '
    });
    assert.deepEqual(alias, {
      shell_command: 'Bash',
      read: 'Read'
    });
    assert.equal(normalizeAliasMap({ ' ': 'x', blank_value: '   ' }), undefined);
    assert.equal(normalizeAliasMap({ invalid: 1 }), undefined);
    assert.equal(normalizeAliasMap([]), undefined);
  }

  {
    const fromSemantics = resolveAliasMapFromSemantics({
      tools: {
        toolNameAliasMap: {
          ' shell_command ': ' Bash '
        }
      }
    });
    assert.deepEqual(fromSemantics, {
      shell_command: 'Bash'
    });
  }

  {
    const fromDerived = resolveAliasMapFromSemantics({
      tools: {
        clientToolsRaw: [{ name: 'Bash' }, { name: 'Read' }, { name: '' }, null]
      }
    });
    assert.equal(fromDerived.bash, 'Bash');
    assert.equal(fromDerived.read, 'Read');
  }

  {
    assert.equal(
      resolveAliasMapFromSemantics({
        tools: { clientToolsRaw: [{ nope: true }] }
      }),
      undefined
    );
  }

  {
    const toolsRaw = resolveClientToolsRawFromSemantics({
      tools: {
        clientToolsRaw: [
          { type: 'function', name: 'good' },
          { type: ' ', name: 'skip_blank_type' },
          { name: 'skip_missing_type' },
          [],
          null
        ]
      }
    });
    assert.deepEqual(toolsRaw, [{ type: 'function', name: 'good' }]);
    assert.equal(resolveClientToolsRawFromSemantics({ tools: {} }), undefined);
    assert.equal(resolveClientToolsRawFromSemantics({ tools: { clientToolsRaw: [] } }), undefined);
    assert.equal(resolveClientToolsRawFromSemantics({ tools: { clientToolsRaw: 'not-array' } }), undefined);
  }

  {
    const toolsRaw = resolveClientToolsRaw([
      { type: 'function', name: 'good' },
      { type: ' ', name: 'skip_blank_type' },
      { name: 'skip_missing_type' },
      null
    ]);
    assert.deepEqual(toolsRaw, [{ type: 'function', name: 'good' }]);
    assert.equal(resolveClientToolsRaw([]), undefined);
    assert.equal(resolveClientToolsRaw('not-array'), undefined);
  }

  console.log('✅ coverage-hub-resp-outbound-client-semantics passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-outbound-client-semantics failed:', error);
  process.exit(1);
});
