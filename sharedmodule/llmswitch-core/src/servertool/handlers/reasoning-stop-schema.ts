import type { JsonObject } from '../../conversion/hub/types/json.js';

export const REASONING_STOP_REASON_VALUES = [
  'completed',
  'blocked',
  'user_input',
  'simple_question',
  'plan_mode'
] as const;

export type ReasoningStopReason = (typeof REASONING_STOP_REASON_VALUES)[number];

export const REASONING_STOP_SSOT_WORK_TYPE_VALUES = [
  'feature_impl',
  'bug_fix',
  'analysis_only',
  'other'
] as const;

export type ReasoningStopSsotWorkType = (typeof REASONING_STOP_SSOT_WORK_TYPE_VALUES)[number];

export type ReasoningStopSsotAssessment = {
  workType?: ReasoningStopSsotWorkType;
  isUniqueImplementationPoint?: boolean;
  isBestFixPoint?: boolean;
  rationale: string;
};

export type ReasoningStopPayload = {
  taskGoal: string;
  completed: boolean;
  stopReason?: ReasoningStopReason;
  completionEvidence: string;
  cannotCompleteReason: string;
  blockingEvidence: string;
  attemptsExhausted?: boolean;
  nextStep: string;
  userInputRequired?: boolean;
  userQuestion: string;
  learning?: string;
  isSimpleQuestion?: boolean;
  ssotAssessment?: ReasoningStopSsotAssessment;
};

export type ParsedReasoningStopSummary = ReasoningStopPayload;

export const REASONING_STOP_SUMMARY_ALLOWED_PREFIXES = [
  '用户任务目标:',
  '是否完成:',
  '完成证据:',
  '停止原因:',
  '下一步:',
  '需用户参与:',
  '用户问题:',
  '已穷尽可行尝试:',
  '穷尽所有尝试:',
  '无法完成原因:',
  '阻塞证据:',
  '经验沉淀:',
  '是否简单问题:',
  '简单问题:',
  '工作类型:',
  '是否唯一实现点:',
  '是否最佳修复点:',
  '真源判断依据:',
  '结束标记:'
] as const;

export const REASONING_STOP_TOOL_DESCRIPTION =
  'Structured stop self-check gate. Stop is allowed only when either: (A) task is completed with completion_evidence and a ssot_assessment that states whether this is the unique implementation point or best fix point as applicable; or (B) all feasible attempts are exhausted and the task is irrecoverably blocked, with cannot_complete_reason + blocking_evidence + attempts_exhausted=true; or (C) is_simple_question=true (simple factual question that can be answered directly). If the current task is plan mode / audit / other intentionally read-only work and the requested deliverable is already complete, set is_completed=true, stop_reason=plan_mode, and provide completion_evidence plus ssot_assessment. If user input is required, also provide user_input_required=true and user_question. Required: task_goal, is_completed. If not completed but a concrete next action exists, fill next_step and continue instead of stopping.';

export const REASONING_STOP_TOOL_PARAMETERS_PROPERTIES: Record<string, JsonObject> = {
  task_goal: { type: 'string' },
  is_completed: { type: 'boolean' },
  stop_reason: {
    type: 'string',
    enum: [...REASONING_STOP_REASON_VALUES],
    description:
      'Optional structured stop reason. Use plan_mode for plan/audit/other intentionally read-only tasks whose requested deliverable is already complete.'
  },
  completion_evidence: { type: 'string' },
  cannot_complete_reason: { type: 'string' },
  blocking_evidence: { type: 'string' },
  attempts_exhausted: { type: 'boolean' },
  next_step: { type: 'string' },
  user_input_required: { type: 'boolean' },
  user_question: { type: 'string' },
  learning: { type: 'string' },
  is_simple_question: {
    type: 'boolean',
    description: 'True if this is a simple factual question that can be answered directly without further execution'
  },
  ssot_assessment: {
    type: 'object',
    description:
      'Required when is_completed=true. For feature_impl, also specify is_unique_implementation_point. For bug_fix, also specify is_best_fix_point. Always include rationale.',
    properties: {
      work_type: {
        type: 'string',
        enum: [...REASONING_STOP_SSOT_WORK_TYPE_VALUES]
      },
      is_unique_implementation_point: {
        type: 'boolean',
        description: 'Required when work_type=feature_impl.'
      },
      is_best_fix_point: {
        type: 'boolean',
        description: 'Required when work_type=bug_fix.'
      },
      rationale: {
        type: 'string',
        description: 'Why this is the unique implementation point, best fix point, or why those checks are not applicable.'
      }
    },
    additionalProperties: false
  }
};
