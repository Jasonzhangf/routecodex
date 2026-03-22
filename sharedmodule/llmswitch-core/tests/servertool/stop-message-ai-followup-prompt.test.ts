import { describe, expect, test } from '@jest/globals';

import {
  buildStopMessageAutoMessageIflowPromptForTests,
  type StopMessageAiFollowupHistoryEntry,
  type StopMessageAutoResponseSnapshot
} from '../../src/servertool/handlers/stop-message-auto/iflow-followup.js';

describe('stop_message_auto ai followup prompt', () => {
  test('enforces pragmatic review with primary-goal-first judgement', () => {
    const responseSnapshot: StopMessageAutoResponseSnapshot = {
      providerProtocol: 'openai-responses',
      finishReason: 'stop',
      assistantText: '已完成部分修复，下一步待补测试。',
      reasoningText: '需要先确认当前实现是否覆盖边界分支。',
      responseExcerpt: '当前分支通过了构建，但回归样本仍有失败。'
    };

    const historyEntries: StopMessageAiFollowupHistoryEntry[] = [
      {
        round: 1,
        assistantText: '先跑构建并收集失败用例。',
        followupText: '补充测试并验证错误样本。',
        reasoningText: '目标是提升覆盖率并避免回归。'
      }
    ];

    const prompt = buildStopMessageAutoMessageIflowPromptForTests({
      baseStopMessageText: '继续执行',
      candidateFollowupText: '修复 stopMessage 循环并补齐覆盖测试',
      responseSnapshot,
      workingDirectory: '/repo/project',
      requestId: 'req_1',
      sessionId: 'session_1',
      providerKey: 'qwen.1',
      model: 'qwen3.5-plus',
      usedRepeats: 2,
      maxRepeats: 10,
      doneMarker: '[STOPMESSAGE_DONE]',
      isFirstPrompt: true,
      historyEntries
    });

    expect(prompt).toContain('overallGoal(短期目标): 修复 stopMessage 循环并补齐覆盖测试');
    expect(prompt).toContain('historyRecord(xxx): 见下方 stopMessage 历史轨迹');
    expect(prompt).toContain('modelFeedback(消息内容): 见下方 assistantText/reasoningText/responseExcerpt');
    expect(prompt).toContain('角色定位：你是“执行审稿人（reviewer）”，默认做审慎核验但不要吹毛求疵，仍以证据驱动判断。');
    expect(prompt).toContain('先做代码 review（最多一句），再给指令：必须结合 workingDirectory 下当前实现/测试/构建状态给出建议；不能只做抽象建议。');
    expect(prompt).toContain('主模型若声明“完成了某项”，优先核验与 overallGoal 直接相关的关键项；非关键分支/小目标可记录为后续补充验证，不必阻塞推进。');
    expect(prompt).toContain('通过标准以“总体目标是否达成”为主；当主目标证据充分时，允许次要项暂未验证，并给出后续补测建议。');
    expect(prompt).toContain('若主模型声称“无法完成/被阻塞”，你必须要求其提供阻塞证据，并判断是否存在可继续推进的最小可执行动作。');
    expect(prompt).toContain('必要时必须要求其打开并检查已改代码（明确到文件），再给出具体修改建议，不允许停留在抽象层面。');
    expect(prompt).toContain(
      '必须先根据本次请求逐条核验（目标/范围/约束）后再给建议：至少引用一个代码证据（文件路径+关键实现点），若涉及行为变更还要引用测试/命令证据或明确说明未执行原因。'
    );
    expect(prompt).toContain('禁止“先给建议、后补证据”；核验结论必须先于建议给出，且每条建议都要可追溯到对应证据。');
    expect(prompt).toContain('只有在消息内容或历史记录里存在明确证据时，才允许判断“偏离目标”；否则按同轨推进，不要泛化指责偏离。');
    expect(prompt).toContain('若判定偏离，必须在指令里点明证据来源（来自消息内容或历史记录）并给出回轨的最小动作；若无证据，直接给下一步动作。');
    expect(prompt).toContain('禁止连续安排纯只读/纯汇报命令（如 cargo llvm-cov report、cat/head/tail/rg/git status）');
    expect(prompt).toContain('覆盖率类命令只能作为写动作后的验证步骤，不能作为本轮唯一或首要动作。');
    expect(prompt).toContain('workingDirectory: /repo/project');
    expect(prompt).toContain('当关键路径证据充分且确认已完成总体目标时，允许只输出 [STOPMESSAGE_APPROVED] 作为完成信号');
  });

  test('falls back to base stop message as short-term goal when candidate is empty', () => {
    const prompt = buildStopMessageAutoMessageIflowPromptForTests({
      baseStopMessageText: '优先修复 oauth 认证流程',
      candidateFollowupText: '',
      responseSnapshot: {
        assistantText: '已定位到认证入口。'
      },
      usedRepeats: 0,
      maxRepeats: 0
    });

    expect(prompt).toContain('overallGoal(短期目标): 优先修复 oauth 认证流程');
  });
});
