import type {
  ParsedReasoningStopSummary,
  ReasoningStopPayload,
  ReasoningStopSsotAssessment
} from './reasoning-stop-schema.js';

export type NormalizeReasoningStopPayloadResult =
  | {
      ok: true;
      payload: ReasoningStopPayload;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export function validateCompletedSsotAssessment(
  assessment: ReasoningStopSsotAssessment | undefined
): NormalizeReasoningStopPayloadResult | null {
  if (!assessment) {
    return {
      ok: false,
      code: 'SSOT_ASSESSMENT_REQUIRED',
      message: 'reasoning.stop requires ssot_assessment when is_completed=true.'
    };
  }
  if (!assessment.workType) {
    return {
      ok: false,
      code: 'SSOT_WORK_TYPE_REQUIRED',
      message: 'reasoning.stop requires ssot_assessment.work_type when is_completed=true.'
    };
  }
  if (!assessment.rationale) {
    return {
      ok: false,
      code: 'SSOT_RATIONALE_REQUIRED',
      message: 'reasoning.stop requires ssot_assessment.rationale when is_completed=true.'
    };
  }
  if (assessment.workType === 'feature_impl' && typeof assessment.isUniqueImplementationPoint !== 'boolean') {
    return {
      ok: false,
      code: 'SSOT_UNIQUE_IMPLEMENTATION_REQUIRED',
      message:
        'reasoning.stop requires ssot_assessment.is_unique_implementation_point(boolean) when work_type=feature_impl.'
    };
  }
  if (assessment.workType === 'bug_fix' && typeof assessment.isBestFixPoint !== 'boolean') {
    return {
      ok: false,
      code: 'SSOT_BEST_FIX_POINT_REQUIRED',
      message: 'reasoning.stop requires ssot_assessment.is_best_fix_point(boolean) when work_type=bug_fix.'
    };
  }
  return null;
}

export function isIrrecoverablyBlockedStop(parsed: {
  completed?: boolean;
  nextStep: string;
  attemptsExhausted?: boolean;
  cannotCompleteReason: string;
  blockingEvidence: string;
  userInputRequired?: boolean;
  userQuestion: string;
}): boolean {
  if (parsed.completed === true) {
    return false;
  }
  if (parsed.nextStep) {
    return false;
  }
  if (parsed.attemptsExhausted !== true) {
    return false;
  }
  if (!parsed.cannotCompleteReason || !parsed.blockingEvidence) {
    return false;
  }
  if (parsed.userInputRequired === true && !parsed.userQuestion) {
    return false;
  }
  return true;
}

function isCompletedSsotAssessmentValid(assessment: ReasoningStopSsotAssessment | undefined): boolean {
  return validateCompletedSsotAssessment(assessment) === null;
}

export function isValidCompletedStop(parsed: ParsedReasoningStopSummary): boolean {
  if (parsed.completed !== true) {
    return false;
  }
  if (!parsed.completionEvidence) {
    return false;
  }
  if (!isCompletedSsotAssessmentValid(parsed.ssotAssessment)) {
    return false;
  }
  if (parsed.userInputRequired === true) {
    return false;
  }
  if (parsed.userQuestion) {
    return false;
  }
  if (parsed.nextStep || parsed.cannotCompleteReason || parsed.blockingEvidence) {
    return false;
  }
  return true;
}

export function buildReasoningStopFinalizedPayload(parsed: ParsedReasoningStopSummary): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tool: 'reasoning.stop',
    completed: parsed.completed === true
  };
  if (parsed.taskGoal) {
    payload.task_goal = parsed.taskGoal;
  }
  if (parsed.completionEvidence) {
    payload.completion_evidence = parsed.completionEvidence;
  }
  if (parsed.stopReason) {
    payload.stop_reason = parsed.stopReason;
  }
  if (parsed.cannotCompleteReason) {
    payload.cannot_complete_reason = parsed.cannotCompleteReason;
  }
  if (parsed.blockingEvidence) {
    payload.blocking_evidence = parsed.blockingEvidence;
  }
  if (typeof parsed.attemptsExhausted === 'boolean') {
    payload.attempts_exhausted = parsed.attemptsExhausted;
  }
  if (typeof parsed.userInputRequired === 'boolean') {
    payload.user_input_required = parsed.userInputRequired;
  }
  if (parsed.userQuestion) {
    payload.user_question = parsed.userQuestion;
  }
  if (parsed.nextStep) {
    payload.next_step = parsed.nextStep;
  }
  if (parsed.ssotAssessment) {
    payload.ssot_assessment = {
      ...(parsed.ssotAssessment.workType ? { work_type: parsed.ssotAssessment.workType } : {}),
      ...(typeof parsed.ssotAssessment.isUniqueImplementationPoint === 'boolean'
        ? { is_unique_implementation_point: parsed.ssotAssessment.isUniqueImplementationPoint }
        : {}),
      ...(typeof parsed.ssotAssessment.isBestFixPoint === 'boolean'
        ? { is_best_fix_point: parsed.ssotAssessment.isBestFixPoint }
        : {}),
      ...(parsed.ssotAssessment.rationale ? { rationale: parsed.ssotAssessment.rationale } : {})
    };
  }
  return payload;
}
