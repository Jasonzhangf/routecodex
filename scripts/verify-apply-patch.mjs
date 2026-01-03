#!/usr/bin/env node
/**
 * Minimal apply_patch governance verifier (CI client)
 *
 * 直接调用 llmswitch-core 的文本 → tool_calls → 校验链路，
 * 用统一 diff（*** Begin Patch/*** End Patch）触发 apply_patch。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const coreLoaderPath = path.join(repoRoot, 'dist', 'modules', 'llmswitch', 'core-loader.js');
const coreLoaderUrl = pathToFileURL(coreLoaderPath).href;
const { importCoreModule } = await import(coreLoaderUrl);

async function loadCoreModule(subpath) {
  return importCoreModule(subpath);
}

async function runApplyPatchTextCase(label, patchText) {
  const { normalizeAssistantTextToToolCalls } = await loadCoreModule(
    'conversion/shared/text-markup-normalizer'
  );
  const { canonicalizeChatResponseTools } = await loadCoreModule(
    'conversion/shared/tool-canonicalizer'
  );
  const { validateToolCall } = await loadCoreModule('tools/tool-registry');

  const message = {
    role: 'assistant',
    content: patchText
  };
  const normalizedMsg = normalizeAssistantTextToToolCalls(message);
  const toolCalls = normalizedMsg?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error(`[verify-apply-patch] ${label}: text normalizer did not produce tool_calls`);
  }

  const chatPayload = {
    id: `chatcmpl_apply_patch_${label}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4.1',
    choices: [
      {
        index: 0,
        message: normalizedMsg,
        finish_reason: 'tool_calls'
      }
    ]
  };

  const canonical = canonicalizeChatResponseTools(chatPayload);
  const tc = canonical?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc || typeof tc !== 'object') {
    throw new Error(`[verify-apply-patch] ${label}: missing tool_calls after canonicalization`);
  }

  const fn = tc.function || {};
  if (fn.name !== 'apply_patch') {
    throw new Error(
      `[verify-apply-patch] ${label}: expected apply_patch, got ${JSON.stringify(fn.name)}`
    );
  }
  if (typeof fn.arguments !== 'string' || !fn.arguments.trim()) {
    throw new Error(
      `[verify-apply-patch] ${label}: arguments must be non-empty JSON string, got ${typeof fn.arguments}`
    );
  }
  const validation = validateToolCall(fn.name, fn.arguments);
  if (!validation?.ok) {
    throw new Error(
      `[verify-apply-patch] ${label}: validateToolCall failed with reason=${validation?.reason}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(validation.normalizedArgs || fn.arguments);
  } catch (error) {
    throw new Error(
      `[verify-apply-patch] ${label}: normalized arguments not valid JSON: ${(error && error.message) || String(error)}`
    );
  }
  if (typeof parsed.patch !== 'string' || !parsed.patch.includes('*** Begin Patch')) {
    throw new Error(
      `[verify-apply-patch] ${label}: normalized arguments missing patch text`
    );
  }
  if (typeof parsed.input !== 'string' || !parsed.input.includes('*** Begin Patch')) {
    throw new Error(
      `[verify-apply-patch] ${label}: normalized arguments missing input mirror`
    );
  }
}

async function main() {
  if (String(process.env.ROUTECODEX_VERIFY_SKIP || '').trim() === '1') {
    console.log('[verify-apply-patch] 跳过（ROUTECODEX_VERIFY_SKIP=1）');
    process.exit(0);
  }

  try {
    const plainPatch =
      '*** Begin Patch\n' +
      '*** Add File: hello.txt\n' +
      '+Hello from apply_patch\n' +
      '*** End Patch\n';

    const fencedPatch =
      '```patch\n' +
      '*** Begin Patch\n' +
      '*** Add File: hello-fenced.txt\n' +
      '+Hello from apply_patch (fenced)\n' +
      '*** End Patch\n' +
      '```';

    await runApplyPatchTextCase('plain', plainPatch);
    await runApplyPatchTextCase('fenced', fencedPatch);

    console.log('✅ verify-apply-patch: text→tool_calls pipeline passed');
  } catch (error) {
    console.error(error);
    console.error(
      '❌ verify-apply-patch 失败:',
      error instanceof Error ? error.message : String(error ?? 'Unknown error')
    );
    process.exit(1);
  }
}

main();
