#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function score(pass, total) {
  return total === 0 ? 1 : pass / total;
}

function deepEqual(a, b) {
  assert.deepEqual(a, b);
}

async function loadModules() {
  const nativeSemantics = await import(
    moduleUrl('native/router-hotpath/native-hub-bridge-policy-semantics.js')
  );
  return { nativeSemantics };
}

function runCase(fn) {
  fn();
  return true;
}

async function main() {
  const modules = await loadModules();
  const allowlistsFromNative = modules.nativeSemantics.resolveHubProtocolAllowlistsWithNative();
  const protocols = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-chat'];

  let passed = 0;
  let total = 0;
  const bump = (fn) => {
    total += 1;
    if (runCase(fn)) passed += 1;
  };

  bump(() => {
    assert.ok(Array.isArray(allowlistsFromNative.openaiChatAllowedFields));
    assert.ok(Array.isArray(allowlistsFromNative.openaiChatParametersWrapperAllowKeys));
    assert.ok(Array.isArray(allowlistsFromNative.openaiResponsesAllowedFields));
    assert.ok(Array.isArray(allowlistsFromNative.openaiResponsesParametersWrapperAllowKeys));
    assert.ok(Array.isArray(allowlistsFromNative.anthropicAllowedFields));
    assert.ok(Array.isArray(allowlistsFromNative.anthropicParametersWrapperAllowKeys));
    assert.ok(Array.isArray(allowlistsFromNative.geminiAllowedFields));
  });

  bump(() => {
    assert.ok(allowlistsFromNative.openaiChatAllowedFields.includes('messages'));
    assert.ok(allowlistsFromNative.openaiResponsesAllowedFields.includes('input'));
    assert.ok(allowlistsFromNative.anthropicAllowedFields.includes('messages'));
    assert.ok(allowlistsFromNative.geminiAllowedFields.includes('contents'));
  });

  bump(() => {
    for (const protocol of protocols) {
      const fromNative = modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol,
        allowlists: allowlistsFromNative
      });
      assert.equal(fromNative.id, protocol);
    }
  });

  bump(() => {
    const unknown = modules.nativeSemantics.resolveHubProtocolSpecWithNative({
      protocol: 'unknown-protocol',
      allowlists: allowlistsFromNative
    });
    assert.equal(unknown.id, 'openai-chat');
  });

  bump(() => {
    const empty = modules.nativeSemantics.resolveHubProtocolSpecWithNative({
      protocol: '',
      allowlists: allowlistsFromNative
    });
    assert.equal(empty.id, 'openai-chat');
    const undef = modules.nativeSemantics.resolveHubProtocolSpecWithNative({
      protocol: undefined,
      allowlists: allowlistsFromNative
    });
    assert.equal(undef.id, 'openai-chat');
  });

  bump(() => {
    assert.equal(
      modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol: 'openai-chat',
        allowlists: allowlistsFromNative
      }).toolSurface.expectedToolFormat,
      'openai'
    );
    assert.equal(
      modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol: 'openai-responses',
        allowlists: allowlistsFromNative
      }).toolSurface.expectedToolFormat,
      'openai'
    );
    assert.equal(
      modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol: 'anthropic-messages',
        allowlists: allowlistsFromNative
      }).toolSurface.expectedToolFormat,
      'anthropic'
    );
    assert.equal(
      modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol: 'gemini-chat',
        allowlists: allowlistsFromNative
      }).toolSurface.expectedToolFormat,
      'gemini'
    );
  });

  bump(() => {
    for (const protocol of protocols) {
      const spec = modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol,
        allowlists: allowlistsFromNative
      });
      assert.equal(Array.isArray(spec?.providerOutbound?.reservedKeyPrefixes), true);
      assert.equal(Array.isArray(spec?.providerOutbound?.forbidWrappers), true);
      assert.equal(Array.isArray(spec?.providerOutbound?.flattenWrappers), true);
    }
  });

  const ratio = score(passed, total);
  if (ratio < 0.95) {
    throw new Error(`protocol-field-allowlists blackbox coverage ${ratio.toFixed(3)} < 0.95 (${passed}/${total})`);
  }
  console.log(
    `✅ coverage-hub-protocol-field-allowlists passed ${passed}/${total} (${(ratio * 100).toFixed(1)}%)`
  );
}

main().catch((err) => {
  console.error('❌ coverage-hub-protocol-field-allowlists failed:', err);
  process.exit(1);
});
