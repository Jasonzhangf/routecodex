import type { ReasoningStopMode } from './reasoning-stop-state.js';

const CONTINUE_TEXT_PREFIX = '你在上一轮 reasoning.stop 自查中给出了下一步计划。';

export const ON_CONTINUE_TEXT =
  '禁止直接停止。你当前处于 reasoning.stop 模式。每次停止前必须调用 reasoning.stop 工具并提供以下信息：\n' +
  '- 是否完成: 是/否\n' +
  '- 停止原因(stop_reason): 可选。若当前是 plan mode / audit / 其他只读任务，且请求的交付物已经完成，可填 plan_mode\n' +
  '- 完成证据(completion_evidence): 如果任务完成，提供具体证据\n' +
  '- 真源判断(ssot_assessment): 如果你宣称已完成，必须提供 work_type(feature_impl/bug_fix/analysis_only/other)、rationale；若为 feature_impl 还必须提供 is_unique_implementation_point，若为 bug_fix 还必须提供 is_best_fix_point\n' +
  '- 未完成原因(cannot_complete_reason): 如果未完成，说明为什么\n' +
  '- 阻塞证据(blocking_evidence): 如果被阻塞，提供具体阻塞点\n' +
  '- 下一步(next_step): 你计划的下一步行动（如果有）\n' +
  '- 需用户参与(user_input_required): 是否需要用户参与才能继续\n' +
  '- 用户问题(user_question): 如果需要用户参与，具体问什么\n' +
  '你现在立即继续执行，不要停止。';

export const ENDLESS_CONTINUE_TEXT =
  '你当前处于 stopless:endless 模式。默认必须继续执行，不要轻易停止。\n' +
  '只有满足以下任一条件才允许停止：\n' +
  'A. 任务已经完成，并提供 completion_evidence 与 ssot_assessment；若为 feature_impl，必须说明是否唯一实现点；若为 bug_fix，必须说明是否最佳修复点；\n' +
  'A2. 如果这是 plan mode / audit / 其他有意只读任务，且请求的交付物已完成，可在 is_completed=true 的同时设置 stop_reason=plan_mode，但仍需给出 ssot_assessment 说明真源判断依据；\n' +
  'B. 你已经穷尽所有可行尝试，且遇到不可抗阻塞：next_step 为空、attempts_exhausted=true、cannot_complete_reason 非空、blocking_evidence 非空；若必须用户参与，再额外提供 user_input_required=true 与 user_question。\n' +
  '只要还有任何可执行的 next_step，你就必须继续执行，不得停止。\n' +
  '你现在立即继续执行；只有在“已完成”或“不可抗阻塞”时才允许停止。';

export function buildExecuteNextStepText(nextStep: string): string {
  return [
    CONTINUE_TEXT_PREFIX,
    `next_step: ${nextStep}`,
    '现在立即执行该 next_step，不要停止。',
    '如果你后续想停止，必须再次调用 reasoning.stop；若宣称已完成，还必须补齐 completion_evidence 与 ssot_assessment。'
  ].join('\n');
}

export function buildInvalidReasoningStopPrompt(message: string): string {
  const reason = typeof message === 'string' && message.trim().length
    ? message.trim()
    : 'reasoning.stop 参数不合法。';
  return [
    '你刚刚调用的 reasoning.stop 未通过校验，不能据此停止。',
    `错误原因: ${reason}`,
    '请立即继续执行；如果后续仍要停止，必须重新调用 reasoning.stop，并补齐缺失字段。'
  ].join('\n');
}

export function buildReasoningStopFollowupOps(promptText: string): Array<Record<string, unknown>> {
  return [
    { op: 'preserve_tools' },
    { op: 'ensure_standard_tools' },
    { op: 'append_assistant_message', required: false },
    { op: 'append_user_text', text: promptText }
  ];
}

export function resolveGuardPromptByMode(mode: ReasoningStopMode): string {
  return mode === 'endless' ? ENDLESS_CONTINUE_TEXT : ON_CONTINUE_TEXT;
}
