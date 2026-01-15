#!/usr/bin/env node
/**
 * Minimal apply_patch governance verifier (CI client)
 *
 * 直接调用 llmswitch-core 的文本 → tool_calls → 校验链路，
 * 用结构化 apply_patch payload（changes 数组）触发校验。
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

async function runApplyPatchTextCase(label, payloadText) {
  const { normalizeAssistantTextToToolCalls } = await loadCoreModule(
    'conversion/shared/text-markup-normalizer'
  );
  const { canonicalizeChatResponseTools } = await loadCoreModule(
    'conversion/shared/tool-canonicalizer'
  );
  const { validateToolCall } = await loadCoreModule('tools/tool-registry');

  const message = {
    role: 'assistant',
    content: payloadText
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
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[verify-apply-patch] ${label}: normalized arguments not an object`);
  }
  const normalizedPatchText =
    typeof parsed.patch === 'string'
      ? parsed.patch
      : typeof parsed.input === 'string'
        ? parsed.input
        : null;
  if (!normalizedPatchText) {
    throw new Error(`[verify-apply-patch] ${label}: normalized arguments missing patch text`);
  }
  if (!normalizedPatchText.includes('*** Begin Patch') || !normalizedPatchText.includes('*** End Patch')) {
    throw new Error(`[verify-apply-patch] ${label}: patch text missing unified diff markers`);
  }
}

async function main() {
  if (String(process.env.ROUTECODEX_VERIFY_SKIP || '').trim() === '1') {
    console.log('[verify-apply-patch] 跳过（ROUTECODEX_VERIFY_SKIP=1）');
    process.exit(0);
  }

  try {
    const { validateToolCall } = await loadCoreModule('tools/tool-registry');

    // Regression: tolerate newline-escaped patch text (e.g. "*** Begin Patch\\n...") and
    // normalize into a real multi-line unified diff string.
    {
      const escapedPatch = '*** Begin Patch\\n*** End Patch';
      const validation = validateToolCall('apply_patch', escapedPatch);
      if (!validation?.ok) {
        throw new Error(
          `[verify-apply-patch] escaped_patch: validateToolCall failed with reason=${validation?.reason}`
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(validation.normalizedArgs);
      } catch (error) {
        throw new Error(
          `[verify-apply-patch] escaped_patch: normalized arguments not valid JSON: ${(error && error.message) || String(error)}`
        );
      }
      const patchText =
        typeof parsed?.patch === 'string'
          ? parsed.patch
          : typeof parsed?.input === 'string'
            ? parsed.input
            : '';
      if (!patchText || typeof patchText !== 'string') {
        throw new Error('[verify-apply-patch] escaped_patch: missing patch text in normalized args');
      }
      if (patchText.includes('\\n') && !patchText.includes('\n')) {
        throw new Error('[verify-apply-patch] escaped_patch: patch still contains literal \\\\n without real newlines');
      }
      if (patchText.split('\n')[0] !== '*** Begin Patch') {
        throw new Error('[verify-apply-patch] escaped_patch: patch first line is not *** Begin Patch');
      }
    }

    // Regression: validateToolCall should be idempotent for already-normalized JSON arguments.
    // Previously we could mis-detect the whole JSON as patch text, producing a merged line like:
    //   "*** End Patch\",\"input\":\"*** Begin Patch"
    {
      const patchText = '*** Begin Patch\n*** End Patch';
      const alreadyNormalized = JSON.stringify({ patch: patchText, input: patchText });
      const validation = validateToolCall('apply_patch', alreadyNormalized);
      if (!validation?.ok) {
        throw new Error(
          `[verify-apply-patch] already_normalized: validateToolCall failed with reason=${validation?.reason}`
        );
      }
      const parsed = JSON.parse(validation.normalizedArgs);
      const normalizedPatchText =
        typeof parsed?.patch === 'string'
          ? parsed.patch
          : typeof parsed?.input === 'string'
            ? parsed.input
            : '';
      if (!normalizedPatchText) {
        throw new Error('[verify-apply-patch] already_normalized: missing patch text in normalized args');
      }
      if (normalizedPatchText.includes('","input":"*** Begin Patch') || normalizedPatchText.includes('*** End Patch","input":"')) {
        throw new Error('[verify-apply-patch] already_normalized: patch text incorrectly contains serialized JSON keys');
      }
      if (normalizedPatchText.split('\n')[0] !== '*** Begin Patch') {
        throw new Error('[verify-apply-patch] already_normalized: patch first line is not *** Begin Patch');
      }
      if (!normalizedPatchText.includes('*** End Patch')) {
        throw new Error('[verify-apply-patch] already_normalized: patch missing *** End Patch');
      }
    }

    // Regression: patches can contain ``` blocks inside file content; do not treat them as outer fences.
    {
      const patchText = [
        '*** Begin Patch',
        '*** Add File: src/demo-codefence.md',
        '+```json',
        '+{\"ok\":true}',
        '+```',
        '*** End Patch'
      ].join('\n');
      const validation = validateToolCall('apply_patch', patchText);
      if (!validation?.ok) {
        throw new Error(
          `[verify-apply-patch] inner_codefence: validateToolCall failed with reason=${validation?.reason}`
        );
      }
      const parsed = JSON.parse(validation.normalizedArgs);
      const normalizedPatchText =
        typeof parsed?.patch === 'string'
          ? parsed.patch
          : typeof parsed?.input === 'string'
            ? parsed.input
            : '';
      if (!normalizedPatchText.startsWith('*** Begin Patch')) {
        throw new Error('[verify-apply-patch] inner_codefence: patch lost *** Begin Patch header');
      }
      if (!normalizedPatchText.includes('*** Add File: src/demo-codefence.md')) {
        throw new Error('[verify-apply-patch] inner_codefence: missing Add File header');
      }
      if (!normalizedPatchText.includes('+```json') || !normalizedPatchText.includes('+```')) {
        throw new Error('[verify-apply-patch] inner_codefence: missing fenced lines inside patch');
      }
    }

    // Regression: tolerate newline-escaped snippets inside structured payload fields.
    // Some models/clients double-escape multi-line anchors/targets (e.g. "\\n  ").
    {
      const structuredArgs = JSON.stringify({
        file: 'src/demo-escaped-snippet.ts',
        changes: [
          {
            kind: 'replace',
            target: 'const alpha = 1;\\n  const beta = 2;',
            lines: ['const alpha = 1;', '  const beta = 3;']
          }
        ]
      });
      const validation = validateToolCall('apply_patch', structuredArgs);
      if (!validation?.ok) {
        throw new Error(
          `[verify-apply-patch] escaped_structured_snippet: validateToolCall failed with reason=${validation?.reason}`
        );
      }
      const parsed = JSON.parse(validation.normalizedArgs);
      const patchText =
        typeof parsed?.patch === 'string'
          ? parsed.patch
          : typeof parsed?.input === 'string'
            ? parsed.input
            : '';
      if (!patchText) {
        throw new Error('[verify-apply-patch] escaped_structured_snippet: missing patch text in normalized args');
      }
      if (patchText.includes('const alpha = 1;\\n') || patchText.includes('\\n  const beta = 2;')) {
        throw new Error('[verify-apply-patch] escaped_structured_snippet: patch still contains literal \\\\n in target');
      }
      if (!patchText.includes('-const alpha = 1;') || !patchText.includes('-  const beta = 2;')) {
        throw new Error('[verify-apply-patch] escaped_structured_snippet: expected multi-line "-" target not found');
      }
    }

    const plainJson = JSON.stringify({
      file: 'src/demo.ts',
      changes: [
        {
          kind: 'insert_after',
          anchor: 'const foo = 1;',
          lines: ['const bar = 2;']
        }
      ]
    }, null, 2);

    const fencedJson =
      '```json\n' +
      JSON.stringify({
        file: 'src/demo-fenced.ts',
        changes: [
          {
            kind: 'replace',
            target: 'const status = "old";',
            lines: ['const status = "new";']
          }
        ]
      }, null, 2) +
      '\n```';

    await runApplyPatchTextCase('plain', plainJson);
    await runApplyPatchTextCase('fenced', fencedJson);

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
