#!/usr/bin/env node

import assert from 'node:assert/strict';

import { buildStopMessageAutoMessageIflowPromptForTests } from '../../dist/servertool/handlers/stop-message-auto/iflow-followup.js';

async function main() {
  try {
    const output = buildStopMessageAutoMessageIflowPromptForTests(
      {
        baseStopMessageText: '继续执行',
        candidateFollowupText: '优先补充 stopMessage 覆盖测试并验证',
        responseSnapshot: {
          providerProtocol: 'openai-responses',
          finishReason: 'stop',
          assistantText: '已完成基础拆分，待补 clear 分支覆盖。',
          reasoningText: '下一步需要做 clear 持久化删除与回归验证。',
          responseExcerpt: '...stop message excerpt...'
        },
        requestId: 'req_prompt_shape',
        sessionId: 'sess_prompt_shape',
        providerKey: 'iflow.2-173.kimi-k2.5',
        model: 'kimi-k2.5',
        workingDirectory: '/Users/fanzhang/Documents/github/routecodex',
        usedRepeats: 2,
        maxRepeats: 5,
        isFirstPrompt: false,
        historyEntries: [
          {
            round: 1,
            assistantText: '已完成基础拆分',
            followupText: '先补 stop message clear 回归'
          },
          {
            round: 2,
            assistantText: 'clear 分支通过，待补 ai followup',
            followupText: '继续补 ai followup 场景'
          }
        ]
      },
      'iflow'
    );

    assert.ok(typeof output === 'string' && output.length > 0, 'prompt builder should return full prompt text');
    assert.ok(output.includes('overallGoal(短期目标): 优先补充 stopMessage 覆盖测试并验证'));
    assert.ok(output.includes('candidateFollowup: 优先补充 stopMessage 覆盖测试并验证'));
    assert.ok(output.includes('repeat: 3/5'));
    assert.ok(output.includes('progress: used=2 next=3 max=5 remaining=2'));
    assert.ok(output.includes('workingDirectory: /Users/fanzhang/Documents/github/routecodex'));
    assert.ok(output.includes('historyRecord(xxx): 见下方 stopMessage 历史轨迹'));
    assert.ok(output.includes('modelFeedback(消息内容): 见下方 assistantText/reasoningText/responseExcerpt'));
    assert.ok(output.includes('当前模型反馈（结构化摘录）：'));
    assert.ok(output.includes('续轮系统提示词（延续同一目标）'));
    assert.ok(output.includes('先做代码 review（最多一句），再给指令：必须结合 workingDirectory 下当前实现/测试/构建状态给出建议；不能只做抽象建议。'));
    assert.ok(output.includes('只有在消息内容或历史记录里存在明确证据时，才允许判断“偏离目标”；否则按同轨推进，不要泛化指责偏离。'));
    assert.ok(output.includes('禁止连续安排纯只读/纯汇报命令（如 cargo llvm-cov report、cat/head/tail/rg/git status）'));
    assert.ok(output.includes('覆盖率类命令只能作为写动作后的验证步骤，不能作为本轮唯一或首要动作。'));
    assert.ok(output.includes('stopMessage 历史轨迹（最近轮次，按时间升序）：'));
    assert.ok(output.includes('round=1'));
    assert.ok(output.includes('状态调整后'));
    assert.ok(!output.includes('[STOPMESSAGE_DONE]'));

    console.log('✅ stop-message ai-followup prompt shape checks passed');
  } catch (error) {
    console.error('❌ stop-message ai-followup prompt shape failed:', error);
    process.exit(1);
  }
}

main();
