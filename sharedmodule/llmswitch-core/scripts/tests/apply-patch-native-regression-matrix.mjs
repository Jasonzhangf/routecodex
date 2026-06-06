#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeApplyPatchArgumentsWithNative,
  validateApplyPatchArgumentsWithNative
} from '../../dist/router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import { maybeAugmentApplyPatchErrorContent } from '../../dist/conversion/hub/operation-table/semantic-mappers/chat-mapper.js';
import { runServerSideToolEngine } from '../../dist/servertool/server-side-tools.js';

function parseNormalizedArgs(result) {
  assert.equal(typeof result?.normalizedArguments, 'string', 'normalizedArguments must be string');
  return JSON.parse(result.normalizedArguments);
}

function makeApplyPatchToolCallResponse(args) {
  return {
    id: 'chatcmpl-tool-applypatch-matrix',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_apply_patch_matrix',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: args
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  };
}

async function main() {
  const cwd = process.cwd();
  const tmpDir = path.join(cwd, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const relPath = `tmp/apply-patch-matrix-${process.pid}.txt`;
  const absPath = path.join(cwd, relPath);
  fs.writeFileSync(absPath, 'alpha\nbeta\ngamma\n');

  try {
    // 1) absolute path
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: `*** Begin Patch\n*** Update File: ${absPath}\n@@\n-beta\n+beta2\n*** End Patch`
      });
      assert.equal(result.ok, true, 'absolute path should validate');
      const parsed = parseNormalizedArgs(result);
      assert.equal(parsed.patch.includes(absPath), false, 'absolute path must be relativized');
      assert.ok(parsed.patch.includes(`*** Update File: ${relPath}`), 'relative path must be preserved');
    }

    // 2) line-number-only hunk
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: `*** Begin Patch\n*** Update File: ${relPath}\n@@ -20,1 +20,1 @@\n-beta\n+beta2\n*** End Patch`
      });
      assert.equal(result.ok, true, 'line-number-only hunk should validate');
      const parsed = parseNormalizedArgs(result);
      assert.equal(parsed.patch.includes('@@ -20,1 +20,1 @@'), false, 'guessed line-number hunk must be rebuilt');
      assert.ok(parsed.patch.includes(' alpha\n-beta\n+beta2\n gamma'), 'live context must be injected');
    }

    // 3) mixed internal + GNU should be normalized into canonical apply_patch
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '*** Begin Patch\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch'
      });
      assert.equal(result.ok, true, 'mixed internal + GNU should normalize through the native verdict');
      const parsed = parseNormalizedArgs(result);
      assert.ok(parsed.patch.includes('*** Begin Patch'));
      assert.ok(parsed.patch.includes('*** Update File: demo.txt'));
      assert.ok(parsed.patch.includes('@@ -1 +1 @@'));
      assert.equal(parsed.input, undefined);
    }

    // 4) raw / wrapped / json envelope
    {
      const patch = '*** Begin Patch\n*** Add File: demo.txt\n+hi\n*** End Patch';
      const raw = normalizeApplyPatchArgumentsWithNative(patch);
      const wrapped = normalizeApplyPatchArgumentsWithNative({ input: patch });
      const jsonEnvelope = normalizeApplyPatchArgumentsWithNative({ patch });
      for (const [label, result] of [
        ['raw', raw],
        ['wrapped', wrapped],
        ['json', jsonEnvelope]
      ]) {
        const parsed = parseNormalizedArgs(result);
        assert.equal(parsed.patch, patch, `${label} patch must normalize to canonical patch field`);
        assert.equal(parsed.input, undefined, `${label} input alias must not leak back into canonical args`);
      }
    }

    // 4.1) shell-wrapped apply_patch heredoc must be harvested by explicit apply_patch tool shape
    {
      const shellWrapped = `bash -lc "echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope.ts
+console.log('nope');
*** End Patch
PATCH"`;
      const result = normalizeApplyPatchArgumentsWithNative(shellWrapped);
      const parsed = parseNormalizedArgs(result);
      assert.ok(parsed.patch.includes('*** Begin Patch'), 'shell-wrapped apply_patch must preserve canonical patch');
      assert.ok(parsed.patch.includes('*** Add File: src/nope.ts'), 'shell-wrapped apply_patch must preserve target file');
      assert.ok(parsed.patch.includes("+console.log('nope');"), 'shell-wrapped apply_patch must preserve add-file content');
      assert.equal(parsed.input, undefined, 'shell-wrapped apply_patch input alias must not leak back into canonical args');
    }

    // 4.2) hashline shape missing fileContent must fail-fast instead of silently normalizing to empty patch
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '+ 2 deadbeef\nhello',
        filePath: 'note.txt'
      });
      assert.equal(result.ok, false, 'hashline missing fileContent must stay invalid');
      assert.equal(result.reason, 'hashline_missing_file_content');
    }

    // 5) add-file without leading + should be repaired by native verdict
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '*** Begin Patch\n*** Add File: demo.txt\nhello\n*** End Patch'
      });
      assert.equal(result.ok, true, 'add-file without + should be repaired');
      const parsed = parseNormalizedArgs(result);
      assert.equal(
        parsed.patch,
        '*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch',
        'native verdict must plus-prefix add-file content'
      );
      assert.equal(parsed.input, undefined);
    }

    // 6) file changed -> context mismatch
    {
      const content =
        "apply_patch verification failed: Failed to find context '-50,6 +50,8 @@' in src/server/index.ts";
      const augmented = maybeAugmentApplyPatchErrorContent(content, 'apply_patch');
      assert.ok(augmented.includes('[APPLY_PATCH_CONTEXT_MISMATCH]'), 'context mismatch hint must be stable');
      assert.ok(augmented.includes('更小且唯一的上下文'), 'context mismatch hint must force smaller real context');
    }

    // 7) repeated failure -> enforced read-before-repatch
    {
      const adapterContext = {
        requestId: 'req-apply-patch-native-matrix',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeId: 'coding',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: 'edit AGENTS.md' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_apply_patch_prev',
                  type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: JSON.stringify({
                      patch: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-old\n+new\n*** End Patch'
                    })
                  }
                }
              ]
            },
            {
              role: 'tool',
              tool_call_id: 'call_apply_patch_prev',
              name: 'apply_patch',
              content: "apply_patch verification failed: Failed to find context '-1,1 +1,1 @@' in AGENTS.md"
            }
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object' } }
            }
          ]
        }
      };
      const result = await runServerSideToolEngine({
        chatResponse: makeApplyPatchToolCallResponse(
          JSON.stringify({
            patch: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-older\n+newer\n*** End Patch'
          })
        ),
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-apply-patch-native-matrix',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({ body: {} })
      });
      const output = JSON.parse(String(result.finalChatResponse?.tool_outputs?.[0]?.content || '{}'));
      assert.equal(output.code, 'APPLY_PATCH_REQUIRES_READ_BEFORE_RETRY');
      const ops = result.execution?.followup?.injection?.ops || [];
      assert.ok(ops.some((row) => row?.op === 'preserve_tools'), 'followup must preserve tools');
    }

    console.log('✅ apply_patch native regression matrix passed');
  } finally {
    fs.rmSync(absPath, { force: true });
  }
}

main().catch((error) => {
  console.error('[matrix:apply-patch-native-regression-matrix] failed', error);
  process.exit(1);
});
