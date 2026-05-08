import type {
  ParsedReasoningStopSummary,
  ReasoningStopPayload,
  ReasoningStopReason,
  ReasoningStopSsotWorkType
} from './reasoning-stop-schema.js';
import { normalizeSsotWorkType, normalizeStopReason } from './reasoning-stop-payload-normalizer.js';

export function buildReasoningStopSummary(payload: ReasoningStopPayload): string {
  const lines = [`用户任务目标: ${payload.taskGoal}`, `是否完成: ${payload.completed ? '是' : '否'}`];
  if (payload.stopReason) {
    lines.push(`停止原因: ${payload.stopReason}`);
  }
  if (payload.completed) {
    lines.push(`完成证据: ${payload.completionEvidence}`);
  } else {
    if (typeof payload.userInputRequired === 'boolean') {
      lines.push(`需用户参与: ${payload.userInputRequired ? '是' : '否'}`);
    }
    if (payload.userQuestion) {
      lines.push(`用户问题: ${payload.userQuestion}`);
    }
    if (payload.cannotCompleteReason) {
      if (typeof payload.attemptsExhausted === 'boolean') {
        lines.push(`已穷尽可行尝试: ${payload.attemptsExhausted ? '是' : '否'}`);
      }
      lines.push(`无法完成原因: ${payload.cannotCompleteReason}`);
      if (payload.blockingEvidence) {
        lines.push(`阻塞证据: ${payload.blockingEvidence}`);
      }
    }
    if (payload.nextStep) {
      lines.push(`下一步: ${payload.nextStep}`);
    }
  }
  if (payload.ssotAssessment?.workType) {
    lines.push(`工作类型: ${payload.ssotAssessment.workType}`);
  }
  if (typeof payload.ssotAssessment?.isUniqueImplementationPoint === 'boolean') {
    lines.push(`是否唯一实现点: ${payload.ssotAssessment.isUniqueImplementationPoint ? '是' : '否'}`);
  }
  if (typeof payload.ssotAssessment?.isBestFixPoint === 'boolean') {
    lines.push(`是否最佳修复点: ${payload.ssotAssessment.isBestFixPoint ? '是' : '否'}`);
  }
  if (payload.ssotAssessment?.rationale) {
    lines.push(`真源判断依据: ${payload.ssotAssessment.rationale}`);
  }
  if (payload.learning) {
    lines.push(`经验沉淀: ${payload.learning}`);
  }
  if (typeof payload.isSimpleQuestion === 'boolean') {
    lines.push(`是否简单问题: ${payload.isSimpleQuestion ? '是' : '否'}`);
  }
  return lines.join('\n');
}

export function parseReasoningStopSummary(summary: string): ParsedReasoningStopSummary {
  const normalized = typeof summary === 'string' ? summary.trim() : '';
  if (!normalized) {
    return {
      taskGoal: '',
      completed: false,
      completionEvidence: '',
      cannotCompleteReason: '',
      blockingEvidence: '',
      nextStep: '',
      userQuestion: ''
    };
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  let taskGoal = '';
  let completed = false;
  let completedSet = false;
  let completionEvidence = '';
  let stopReason: ReasoningStopReason | undefined;
  let nextStep = '';
  let userInputRequired: boolean | undefined;
  let userQuestion = '';
  let attemptsExhausted: boolean | undefined;
  let cannotCompleteReason = '';
  let blockingEvidence = '';
  let learning = '';
  let isSimpleQuestion: boolean | undefined;
  let ssotWorkType: ReasoningStopSsotWorkType | undefined;
  let isUniqueImplementationPoint: boolean | undefined;
  let isBestFixPoint: boolean | undefined;
  let ssotRationale = '';

  for (const line of lines) {
    if (line.startsWith('用户任务目标:')) {
      taskGoal = line.slice('用户任务目标:'.length).trim();
      continue;
    }
    if (line.startsWith('是否完成:')) {
      const value = line.slice('是否完成:'.length).trim();
      completedSet = true;
      if (value === '是') {
        completed = true;
      } else if (value === '否') {
        completed = false;
      }
      continue;
    }
    if (line.startsWith('完成证据:')) {
      completionEvidence = line.slice('完成证据:'.length).trim();
      continue;
    }
    if (line.startsWith('停止原因:')) {
      stopReason = normalizeStopReason(line.slice('停止原因:'.length).trim());
      continue;
    }
    if (line.startsWith('下一步:')) {
      nextStep = line.slice('下一步:'.length).trim();
      continue;
    }
    if (line.startsWith('需用户参与:')) {
      const value = line.slice('需用户参与:'.length).trim();
      if (value === '是') {
        userInputRequired = true;
      } else if (value === '否') {
        userInputRequired = false;
      }
      continue;
    }
    if (line.startsWith('用户问题:')) {
      userQuestion = line.slice('用户问题:'.length).trim();
      continue;
    }
    if (line.startsWith('已穷尽可行尝试:') || line.startsWith('穷尽所有尝试:')) {
      const prefix = line.startsWith('已穷尽可行尝试:') ? '已穷尽可行尝试:' : '穷尽所有尝试:';
      const value = line.slice(prefix.length).trim();
      if (value === '是') {
        attemptsExhausted = true;
      } else if (value === '否') {
        attemptsExhausted = false;
      }
      continue;
    }
    if (line.startsWith('无法完成原因:')) {
      cannotCompleteReason = line.slice('无法完成原因:'.length).trim();
      continue;
    }
    if (line.startsWith('阻塞证据:')) {
      blockingEvidence = line.slice('阻塞证据:'.length).trim();
      continue;
    }
    if (line.startsWith('经验沉淀:')) {
      learning = line.slice('经验沉淀:'.length).trim();
      continue;
    }
    if (line.startsWith('是否简单问题:') || line.startsWith('简单问题:')) {
      const prefix = line.startsWith('是否简单问题:') ? '是否简单问题:' : '简单问题:';
      const value = line.slice(prefix.length).trim();
      if (value === '是' || value === 'yes' || value === 'true') {
        isSimpleQuestion = true;
      } else if (value === '否' || value === 'no' || value === 'false') {
        isSimpleQuestion = false;
      }
      continue;
    }
    if (line.startsWith('工作类型:')) {
      ssotWorkType = normalizeSsotWorkType(line.slice('工作类型:'.length).trim());
      continue;
    }
    if (line.startsWith('是否唯一实现点:')) {
      const value = line.slice('是否唯一实现点:'.length).trim();
      if (value === '是') {
        isUniqueImplementationPoint = true;
      } else if (value === '否') {
        isUniqueImplementationPoint = false;
      }
      continue;
    }
    if (line.startsWith('是否最佳修复点:')) {
      const value = line.slice('是否最佳修复点:'.length).trim();
      if (value === '是') {
        isBestFixPoint = true;
      } else if (value === '否') {
        isBestFixPoint = false;
      }
      continue;
    }
    if (line.startsWith('真源判断依据:')) {
      ssotRationale = line.slice('真源判断依据:'.length).trim();
    }
  }

  const ssotAssessment =
    ssotWorkType || ssotRationale || typeof isUniqueImplementationPoint === 'boolean' || typeof isBestFixPoint === 'boolean'
      ? {
          ...(ssotWorkType ? { workType: ssotWorkType } : {}),
          ...(typeof isUniqueImplementationPoint === 'boolean' ? { isUniqueImplementationPoint } : {}),
          ...(typeof isBestFixPoint === 'boolean' ? { isBestFixPoint } : {}),
          rationale: ssotRationale
        }
      : undefined;

  return {
    taskGoal,
    completed: completedSet ? completed : false,
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
  };
}
