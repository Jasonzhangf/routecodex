import type {
  ReasoningStopPayload,
  ReasoningStopReason,
  ReasoningStopSsotAssessment,
  ReasoningStopSsotWorkType
} from './reasoning-stop-schema.js';
import {
  REASONING_STOP_REASON_VALUES,
  REASONING_STOP_SSOT_WORK_TYPE_VALUES
} from './reasoning-stop-schema.js';
import { validateCompletedSsotAssessment, type NormalizeReasoningStopPayloadResult } from './reasoning-stop-validator.js';

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

function readBool(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === 'no') {
      return false;
    }
  }
  return undefined;
}

function readObject(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function readStringArray(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (items.length > 0) {
      return items;
    }
  }
  return undefined;
}

export function normalizeStopReason(raw: string): ReasoningStopReason | undefined {
  const normalized = raw.trim().toLowerCase();
  return REASONING_STOP_REASON_VALUES.includes(normalized as ReasoningStopReason)
    ? (normalized as ReasoningStopReason)
    : undefined;
}

export function normalizeSsotWorkType(raw: string): ReasoningStopSsotWorkType | undefined {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'feature' || normalized === 'feature_implementation') {
    return 'feature_impl';
  }
  if (normalized === 'bug' || normalized === 'bugfix' || normalized === 'bug_fixing') {
    return 'bug_fix';
  }
  if (normalized === 'analysis' || normalized === 'read_only') {
    return 'analysis_only';
  }
  return REASONING_STOP_SSOT_WORK_TYPE_VALUES.includes(normalized as ReasoningStopSsotWorkType)
    ? (normalized as ReasoningStopSsotWorkType)
    : undefined;
}

function readStopReason(record: Record<string, unknown>, keys: string[]): ReasoningStopReason | undefined {
  const raw = readText(record, keys);
  return raw ? normalizeStopReason(raw) : undefined;
}

function readSsotAssessment(record: Record<string, unknown>): ReasoningStopSsotAssessment | undefined {
  const nested = readObject(record, ['ssot_assessment', 'ssotAssessment']);
  const source = nested ?? record;
  const parameterTuple = readStringArray(source, ['parameter', 'parameters']);
  const workTypeRaw =
    readText(source, ['work_type', 'workType', 'kind', 'ssot_work_type', 'ssotWorkType'])
    || parameterTuple?.[0]
    || '';
  const rationale =
    readText(source, ['rationale', 'reason', 'statement', 'ssot_rationale', 'ssotRationale'])
    || parameterTuple?.[1]
    || '';
  const isUniqueImplementationPoint = readBool(source, [
    'is_unique_implementation_point',
    'isUniqueImplementationPoint',
    'is_unique_project_implementation',
    'isUniqueProjectImplementation'
  ]);
  const isBestFixPoint = readBool(source, [
    'is_best_fix_point',
    'isBestFixPoint',
    'is_best_pipeline_fix_point',
    'isBestPipelineFixPoint'
  ]);
  const workType = workTypeRaw ? normalizeSsotWorkType(workTypeRaw) : undefined;
  if (!workType && !rationale && typeof isUniqueImplementationPoint !== 'boolean' && typeof isBestFixPoint !== 'boolean') {
    return undefined;
  }
  return {
    ...(workType ? { workType } : {}),
    ...(typeof isUniqueImplementationPoint === 'boolean' ? { isUniqueImplementationPoint } : {}),
    ...(typeof isBestFixPoint === 'boolean' ? { isBestFixPoint } : {}),
    rationale
  };
}

export function normalizeReasoningStopPayload(args: Record<string, unknown>): NormalizeReasoningStopPayloadResult {
  const taskGoal = readText(args, ['task_goal', 'taskGoal', 'goal']);
  if (!taskGoal) {
    return {
      ok: false,
      code: 'TASK_GOAL_REQUIRED',
      message: 'reasoning.stop requires task_goal.'
    };
  }

  const completed = readBool(args, ['is_completed', 'isCompleted', 'completed']);
  if (typeof completed !== 'boolean') {
    return {
      ok: false,
      code: 'IS_COMPLETED_REQUIRED',
      message: 'reasoning.stop requires is_completed(boolean).'
    };
  }

  const stopReason = readStopReason(args, ['stop_reason', 'stopReason', 'reason_type', 'reasonType']);
  const completionEvidence = readText(args, ['completion_evidence', 'completionEvidence', 'evidence']);
  const cannotCompleteReason = readText(args, ['cannot_complete_reason', 'cannotCompleteReason', 'reason']);
  const blockingEvidence = readText(args, ['blocking_evidence', 'blockingEvidence', 'block_evidence']);
  const attemptsExhausted = readBool(args, [
    'attempts_exhausted',
    'attemptsExhausted',
    'all_attempts_exhausted',
    'allAttemptsExhausted'
  ]);
  const nextStep = readText(args, [
    'next_step',
    'nextStep',
    'next_steps',
    'nextSteps',
    'plan_next_step',
    'next_plan'
  ]);
  const userInputRequired = readBool(args, ['user_input_required', 'userInputRequired']);
  const userQuestion = readText(args, ['user_question', 'userQuestion', 'question_for_user', 'questionForUser']);
  const learning = readText(args, ['learning', 'experience', 'insight', 'lesson', 'lesson_learned']);
  const isSimpleQuestion = readBool(args, [
    'is_simple_question',
    'isSimpleQuestion',
    'simple_question',
    'simpleQuestion'
  ]);
  const ssotAssessment = readSsotAssessment(args);

  if (completed && !completionEvidence) {
    return {
      ok: false,
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      message: 'reasoning.stop requires completion_evidence when is_completed=true.'
    };
  }
  if (completed && userInputRequired === true) {
    return {
      ok: false,
      code: 'USER_INPUT_CONFLICT_WITH_COMPLETED',
      message: 'reasoning.stop cannot set user_input_required=true when is_completed=true.'
    };
  }
  if (completed) {
    const ssotValidation = validateCompletedSsotAssessment(ssotAssessment);
    if (ssotValidation) {
      return ssotValidation;
    }
  }
  if (!completed && userInputRequired === true) {
    if (!cannotCompleteReason) {
      return {
        ok: false,
        code: 'CANNOT_COMPLETE_REASON_REQUIRED_FOR_USER_INPUT',
        message: 'reasoning.stop requires cannot_complete_reason when user_input_required=true.'
      };
    }
    if (!userQuestion) {
      return {
        ok: false,
        code: 'USER_QUESTION_REQUIRED',
        message: 'reasoning.stop requires user_question when user_input_required=true.'
      };
    }
  }
  if (!completed && userInputRequired !== true && !cannotCompleteReason && !nextStep) {
    return {
      ok: false,
      code: 'NEXT_STEP_OR_CANNOT_COMPLETE_REQUIRED',
      message: 'reasoning.stop requires next_step or cannot_complete_reason when is_completed=false.'
    };
  }
  if (!completed && cannotCompleteReason && !nextStep && attemptsExhausted !== true) {
    return {
      ok: false,
      code: 'ATTEMPTS_EXHAUSTED_REQUIRED',
      message: 'reasoning.stop requires attempts_exhausted=true when stopping with cannot_complete_reason.'
    };
  }
  if (!completed && cannotCompleteReason && !nextStep && !blockingEvidence) {
    return {
      ok: false,
      code: 'BLOCKING_EVIDENCE_REQUIRED',
      message: 'reasoning.stop requires blocking_evidence when stopping with cannot_complete_reason.'
    };
  }

  return {
    ok: true,
    payload: {
      taskGoal,
      completed,
      ...(stopReason ? { stopReason } : {}),
      completionEvidence,
      cannotCompleteReason,
      blockingEvidence,
      ...(typeof attemptsExhausted === 'boolean' ? { attemptsExhausted } : {}),
      nextStep,
      ...(typeof userInputRequired === 'boolean' ? { userInputRequired } : {}),
      userQuestion,
      ...(learning ? { learning } : {}),
      ...(typeof isSimpleQuestion === 'boolean' ? { isSimpleQuestion } : {}),
      ...(ssotAssessment ? { ssotAssessment } : {})
    }
  };
}
