import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import {
  renderStopMessageAutoFollowupViaAiAsync,
  extractStopMessageAutoResponseSnapshot
} from './stop-message-auto/ai-followup.js';
import { sanitizeFollowupText } from './followup-sanitize.js';
import {
  getCapturedRequest,
  resolveBdWorkingDirectoryForRecord,
  resolveStopMessageFollowupProviderKey
} from './stop-message-auto/runtime-utils.js';

const FLOW_ID = 'review_flow';
const TOOL_NAME = 'review';
const DEFAULT_REVIEW_GOAL =
  '请作为 reviewer 基于当前代码与测试证据进行审查，指出未完成项并给出最小下一步可执行动作。';

function isReviewAiFollowupEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED ??
      process.env.RCC_REVIEW_AI_FOLLOWUP_ENABLED ??
      ''
  )
    .trim()
    .toLowerCase();
  if (!raw) {
    return true;
  }
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function resolveReviewWorkingDirectory(
  args: Record<string, unknown>,
  record: Record<string, unknown>,
  runtimeMetadata: unknown
): string | undefined {
  const fromArgs = pickText(args, ['workdir', 'cwd', 'workingDirectory']);
  if (fromArgs) {
    return fromArgs;
  }
  const argsInput = asRecord(args.input);
  const fromInput = argsInput ? pickText(argsInput, ['workdir', 'cwd', 'workingDirectory']) : '';
  if (fromInput) {
    return fromInput;
  }
  const fromRecord = pickText(record, ['workdir', 'cwd', 'workingDirectory']);
  if (fromRecord) {
    return fromRecord;
  }
  return resolveBdWorkingDirectoryForRecord(record, runtimeMetadata);
}

function toFlatText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => toFlatText(entry)).filter((entry) => entry.length > 0);
    return Array.from(new Set(parts)).join('\n').trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  const parts = Object.values(record).map((entry) => toFlatText(entry)).filter((entry) => entry.length > 0);
  return Array.from(new Set(parts)).join('\n').trim();
}

function injectToolOutput(base: JsonObject, toolCall: ToolCall, content: unknown): JsonObject {
  const cloned = cloneJson(base);
  const existingOutputs = Array.isArray((cloned as any).tool_outputs)
    ? ((cloned as any).tool_outputs as JsonValue[])
    : [];
  let payloadText: string;
  if (typeof content === 'string') {
    payloadText = content;
  } else {
    try {
      payloadText = JSON.stringify(content ?? {});
    } catch {
      payloadText = String(content ?? '');
    }
  }
  (cloned as any).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: TOOL_NAME,
      content: payloadText
    }
  ];
  return cloned;
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== TOOL_NAME) {
    return null;
  }

  const args = parseToolArguments(toolCall);
  const explicitGoal = pickText(args, ['goal', 'task', 'objective', 'instruction', 'text', 'message']);
  const focus = pickText(args, ['focus']);
  const extraContext = pickText(args, ['context', 'evidence']);
  const fallbackContext = toFlatText(args);
  const reviewGoal = sanitizeFollowupText(explicitGoal || DEFAULT_REVIEW_GOAL);
  const composedGoal = focus ? `${reviewGoal}\nfocus: ${focus}` : reviewGoal;

  const record = ctx.adapterContext as Record<string, unknown>;
  const runtimeMetadata = readRuntimeMetadata(record as Record<string, unknown>);
  const autoResponseSnapshot = extractStopMessageAutoResponseSnapshot(ctx.base, ctx.adapterContext);
  const captured = getCapturedRequest(ctx.adapterContext);
  const seed = captured ? extractCapturedChatSeed(captured) : null;
  const workingDirectory = resolveReviewWorkingDirectory(args, record, runtimeMetadata);

  const fallbackPrompt = [
    '请先做严格代码 review（证据驱动），不要相信“已完成”口头声明。',
    `短期目标：${composedGoal}`,
    extraContext || fallbackContext ? `补充上下文：${extraContext || fallbackContext}` : '',
    '必须先根据本次请求逐条核验代码：明确要核验的目标/范围 -> 打开对应文件并检查实际实现 -> 必要时运行相关测试/构建命令。',
    '要求：逐条给出“声明项 -> 证据（文件路径/测试名/命令输出）-> 是否完成”；缺证据按未完成处理。',
    '输出建议前必须先给“核验结论”，并明确引用触发该结论的代码/日志证据；禁止先给泛化建议再补证据。',
    '然后给出最小下一步写动作（改代码/补测试），并继续执行，不要直接 stop。'
  ]
    .filter(Boolean)
    .join('\n');
  let aiFollowup: string | null = null;
  if (isReviewAiFollowupEnabled()) {
    try {
      aiFollowup = await renderStopMessageAutoFollowupViaAiAsync({
        baseStopMessageText: composedGoal,
        candidateFollowupText: composedGoal,
        responseSnapshot: autoResponseSnapshot,
        requestId: ctx.requestId,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId.trim() : undefined,
        providerKey: resolveStopMessageFollowupProviderKey({
          record: {
            providerKey: record.providerKey,
            providerId: record.providerId,
            metadata: record.metadata
          },
          runtimeMetadata
        }),
        model: typeof seed?.model === 'string' ? seed.model : undefined,
        workingDirectory,
        usedRepeats: 0,
        maxRepeats: 1,
        completionClaimed: false,
        isFirstPrompt: true
      });
    } catch {
      aiFollowup = null;
    }
  }
  const followupText = sanitizeFollowupText(
    typeof aiFollowup === 'string' && aiFollowup.trim() ? aiFollowup.trim() : fallbackPrompt
  );

  return {
    flowId: FLOW_ID,
    finalize: async () => {
      const patched = injectToolOutput(ctx.base, toolCall, {
        ok: true,
        executed: true,
        action: TOOL_NAME,
        message: 'Review request accepted. Reviewer followup has been generated and queued for client injection.'
      });
      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':review_followup',
            injection: {
              ops: [
                { op: 'append_assistant_message', required: false },
                { op: 'append_tool_messages_from_tool_outputs', required: true },
                { op: 'append_user_text', text: followupText }
              ]
            },
            metadata: {
              clientInjectSource: 'servertool.review',
              ...(workingDirectory
                ? {
                    workdir: workingDirectory,
                    cwd: workingDirectory,
                    client_workdir: workingDirectory
                  }
                : {})
            } as JsonObject
          }
        }
      };
    }
  };
};

registerServerToolHandler(TOOL_NAME, handler);
