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
  const protocolAllowlists = await import(moduleUrl('conversion/protocol-field-allowlists.js'));
  const protocolSpec = await import(moduleUrl('conversion/hub/policy/protocol-spec.js'));
  const nativeSemantics = await import(
    moduleUrl('router/virtual-router/engine-selection/native-hub-bridge-policy-semantics.js')
  );
  return { protocolAllowlists, protocolSpec, nativeSemantics };
}

function exportedAllowlists(mod) {
  return {
    openaiChatAllowedFields: mod.OPENAI_CHAT_ALLOWED_FIELDS,
    openaiChatParametersWrapperAllowKeys: mod.OPENAI_CHAT_PARAMETERS_WRAPPER_ALLOW_KEYS,
    openaiResponsesAllowedFields: mod.OPENAI_RESPONSES_ALLOWED_FIELDS,
    openaiResponsesParametersWrapperAllowKeys: mod.OPENAI_RESPONSES_PARAMETERS_WRAPPER_ALLOW_KEYS,
    anthropicAllowedFields: mod.ANTHROPIC_ALLOWED_FIELDS,
    anthropicParametersWrapperAllowKeys: mod.ANTHROPIC_PARAMETERS_WRAPPER_ALLOW_KEYS,
    geminiAllowedFields: mod.GEMINI_ALLOWED_FIELDS
  };
}

function runCase(fn) {
  fn();
  return true;
}

async function main() {
  const modules = await loadModules();
  const allowlistsFromModule = exportedAllowlists(modules.protocolAllowlists);
  const allowlistsFromNative = modules.nativeSemantics.resolveHubProtocolAllowlistsWithNative();
  const protocols = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-chat'];

  let passed = 0;
  let total = 0;
  const bump = (fn) => {
    total += 1;
    if (runCase(fn)) passed += 1;
  };

  bump(() => {
    deepEqual(allowlistsFromModule.openaiChatAllowedFields, allowlistsFromNative.openaiChatAllowedFields);
    deepEqual(
      allowlistsFromModule.openaiChatParametersWrapperAllowKeys,
      allowlistsFromNative.openaiChatParametersWrapperAllowKeys
    );
    deepEqual(allowlistsFromModule.openaiResponsesAllowedFields, allowlistsFromNative.openaiResponsesAllowedFields);
    deepEqual(
      allowlistsFromModule.openaiResponsesParametersWrapperAllowKeys,
      allowlistsFromNative.openaiResponsesParametersWrapperAllowKeys
    );
    deepEqual(allowlistsFromModule.anthropicAllowedFields, allowlistsFromNative.anthropicAllowedFields);
    deepEqual(
      allowlistsFromModule.anthropicParametersWrapperAllowKeys,
      allowlistsFromNative.anthropicParametersWrapperAllowKeys
    );
    deepEqual(allowlistsFromModule.geminiAllowedFields, allowlistsFromNative.geminiAllowedFields);
  });

  bump(() => {
    assert.equal(Object.isFrozen(modules.protocolAllowlists.OPENAI_CHAT_ALLOWED_FIELDS), true);
    assert.equal(Object.isFrozen(modules.protocolAllowlists.OPENAI_RESPONSES_ALLOWED_FIELDS), true);
    assert.equal(Object.isFrozen(modules.protocolAllowlists.ANTHROPIC_ALLOWED_FIELDS), true);
    assert.equal(Object.isFrozen(modules.protocolAllowlists.GEMINI_ALLOWED_FIELDS), true);
  });

  bump(() => {
    assert.ok(modules.protocolAllowlists.OPENAI_CHAT_ALLOWED_FIELDS.includes('messages'));
    assert.ok(modules.protocolAllowlists.OPENAI_RESPONSES_ALLOWED_FIELDS.includes('input'));
    assert.ok(modules.protocolAllowlists.ANTHROPIC_ALLOWED_FIELDS.includes('messages'));
    assert.ok(modules.protocolAllowlists.GEMINI_ALLOWED_FIELDS.includes('contents'));
  });

  bump(() => {
    for (const protocol of protocols) {
      const resolved = modules.protocolSpec.resolveHubProtocolSpec(protocol);
      const fromMap = modules.protocolSpec.HUB_PROTOCOL_SPECS[protocol];
      deepEqual(resolved, fromMap);
    }
  });

  bump(() => {
    for (const protocol of protocols) {
      const fromTs = modules.protocolSpec.resolveHubProtocolSpec(protocol);
      const fromNative = modules.nativeSemantics.resolveHubProtocolSpecWithNative({
        protocol,
        allowlists: allowlistsFromModule
      });
      deepEqual(fromTs, fromNative);
    }
  });

  bump(() => {
    const unknown = modules.protocolSpec.resolveHubProtocolSpec('unknown-protocol');
    deepEqual(unknown, modules.protocolSpec.HUB_PROTOCOL_SPECS['openai-chat']);
    assert.equal(unknown.id, 'openai-chat');
  });

  bump(() => {
    const empty = modules.protocolSpec.resolveHubProtocolSpec('');
    deepEqual(empty, modules.protocolSpec.HUB_PROTOCOL_SPECS['openai-chat']);
    const undef = modules.protocolSpec.resolveHubProtocolSpec(undefined);
    deepEqual(undef, modules.protocolSpec.HUB_PROTOCOL_SPECS['openai-chat']);
  });

  bump(() => {
    assert.equal(modules.protocolSpec.resolveHubProtocolSpec('openai-chat').toolSurface.expectedToolFormat, 'openai');
    assert.equal(
      modules.protocolSpec.resolveHubProtocolSpec('openai-responses').toolSurface.expectedToolFormat,
      'openai'
    );
    assert.equal(
      modules.protocolSpec.resolveHubProtocolSpec('anthropic-messages').toolSurface.expectedToolFormat,
      'anthropic'
    );
    assert.equal(modules.protocolSpec.resolveHubProtocolSpec('gemini-chat').toolSurface.expectedToolFormat, 'gemini');
  });

  bump(() => {
    for (const spec of Object.values(modules.protocolSpec.HUB_PROTOCOL_SPECS)) {
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
