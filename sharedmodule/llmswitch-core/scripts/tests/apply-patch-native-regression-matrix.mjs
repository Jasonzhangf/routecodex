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

    // 3) mixed internal + GNU
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '*** Begin Patch\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch'
      });
      assert.equal(result.ok, false, 'mixed internal + GNU must fail');
      assert.equal(result.reason, 'mixed_gnu_diff');
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
        assert.equal(parsed.input, patch, `${label} input alias must mirror patch`);
      }
    }

    // 5) add-file without leading +
    {
      const result = validateApplyPatchArgumentsWithNative({
        patch: '*** Begin Patch\n*** Add File: demo.txt\nhello\n*** End Patch'
      });
      assert.equal(result.ok, false, 'add-file without + must fail');
      assert.equal(result.reason, 'empty_add_file_block');
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
