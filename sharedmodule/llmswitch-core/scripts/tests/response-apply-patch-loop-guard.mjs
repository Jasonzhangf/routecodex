#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runRespProcessStage1ToolGovernance } from '../../dist/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.js';

function buildApplyPatchToolCall(id, patch) {
  return {
    id,
    type: 'function',
    function: {
      name: 'apply_patch',
      arguments: JSON.stringify({ patch, input: patch })
    }
  };
}

function patchAdd(file) {
  return [
    '*** Begin Patch',
    `*** Add File: ${file}`,
    '+hello',
    '*** End Patch'
  ].join('\n');
}

function patchDelete(file) {
  return [
    '*** Begin Patch',
    `*** Delete File: ${file}`,
    '*** End Patch'
  ].join('\n');
}

async function runOscillatingLoopCase() {
  const payload = {
    id: 'chatcmpl-loop-guard-1',
    object: 'chat.completion',
    model: 'glm-5',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            buildApplyPatchToolCall('call_1', patchAdd('/tmp/loop-a.sh')),
            buildApplyPatchToolCall('call_2', patchDelete('/tmp/loop-a.sh')),
            buildApplyPatchToolCall('call_3', patchAdd('/tmp/loop-b.sh')),
            buildApplyPatchToolCall('call_4', patchDelete('/tmp/loop-b.sh'))
          ]
        }
      }
    ]
  };

  const { governedPayload } = await runRespProcessStage1ToolGovernance({
    payload,
    entryEndpoint: '/v1/responses',
    requestId: 'req_loop_guard_1',
    clientProtocol: 'openai-responses'
  });

  const choice = governedPayload?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls || [];
  assert.equal(toolCalls.length, 0, 'oscillating add/delete apply_patch calls should be removed');
  assert.equal(choice?.finish_reason, 'stop', 'when all tool calls are filtered, finish_reason should become stop');
  assert.match(
    String(choice?.message?.content || ''),
    /RouteCodex guard/i,
    'filtered responses should carry a guard hint'
  );
}

async function runNormalApplyPatchCase() {
  const payload = {
    id: 'chatcmpl-loop-guard-2',
    object: 'chat.completion',
    model: 'glm-5',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [buildApplyPatchToolCall('call_1', patchAdd('/tmp/normal-file.ts'))]
        }
      }
    ]
  };

  const { governedPayload } = await runRespProcessStage1ToolGovernance({
    payload,
    entryEndpoint: '/v1/responses',
    requestId: 'req_loop_guard_2',
    clientProtocol: 'openai-responses'
  });

  const choice = governedPayload?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls || [];
  assert.equal(toolCalls.length, 1, 'normal single apply_patch should not be filtered');
  assert.equal(choice?.finish_reason, 'tool_calls', 'normal apply_patch should keep tool_calls finish reason');
}

async function runShortSinglePathToggleCase() {
  const payload = {
    id: 'chatcmpl-loop-guard-3',
    object: 'chat.completion',
    model: 'glm-5',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            buildApplyPatchToolCall('call_1', patchAdd('/tmp/short-toggle.tmp')),
            buildApplyPatchToolCall('call_2', patchDelete('/tmp/short-toggle.tmp'))
          ]
        }
      }
    ]
  };

  const { governedPayload } = await runRespProcessStage1ToolGovernance({
    payload,
    entryEndpoint: '/v1/responses',
    requestId: 'req_loop_guard_3',
    clientProtocol: 'openai-responses',
    sessionKey: 'session_short_toggle'
  });

  const choice = governedPayload?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls || [];
  assert.equal(toolCalls.length, 2, 'single-path short toggle should not trigger aggressive guard');
}

async function runSessionChurnCase() {
  const sessionKey = 'session_loop_guard_churn';
  const runOne = async (requestId, toolCall) => {
    const payload = {
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      model: 'glm-5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall]
          }
        }
      ]
    };
    return runRespProcessStage1ToolGovernance({
      payload,
      entryEndpoint: '/v1/responses',
      requestId,
      clientProtocol: 'openai-responses',
      sessionKey
    });
  };

  await runOne('req_churn_1_add', buildApplyPatchToolCall('call_1', patchAdd('/Users/me/repo/.c1')));
  await runOne('req_churn_1_del', buildApplyPatchToolCall('call_2', patchDelete('/Users/me/repo/.c1')));
  await runOne('req_churn_2_add', buildApplyPatchToolCall('call_3', patchAdd('/Users/me/repo/.c2')));
  await runOne('req_churn_2_del', buildApplyPatchToolCall('call_4', patchDelete('/Users/me/repo/.c2')));
  await runOne('req_churn_3_add', buildApplyPatchToolCall('call_5', patchAdd('/Users/me/repo/.c3')));
  const blocked = await runOne('req_churn_3_del', buildApplyPatchToolCall('call_6', patchDelete('/Users/me/repo/.c3')));

  const blockedChoice = blocked.governedPayload?.choices?.[0];
  assert.equal(
    (blockedChoice?.message?.tool_calls || []).length,
    0,
    'session churn mode should filter repeated ephemeral add/delete apply_patch calls'
  );
  assert.equal(blockedChoice?.finish_reason, 'stop', 'session churn filtered response should end as stop');
}

async function main() {
  await runOscillatingLoopCase();
  await runNormalApplyPatchCase();
  await runShortSinglePathToggleCase();
  await runSessionChurnCase();
  console.log('[matrix:response-apply-patch-loop-guard] ok');
}

main().catch((err) => {
  console.error('[matrix:response-apply-patch-loop-guard] failed', err);
  process.exit(1);
});
