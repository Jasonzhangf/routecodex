import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';

const FLOW_ID = 'continue_execution_flow';
const TOOL_NAME = 'continue_execution';

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

function normalizeReason(parsed: Record<string, unknown>): string {
  const candidate =
    (typeof parsed.reason === 'string' ? parsed.reason : '') ||
    (typeof parsed.note === 'string' ? parsed.note : '') ||
    (typeof parsed.message === 'string' ? parsed.message : '');
  return candidate.trim();
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== TOOL_NAME) {
    return null;
  }

  const parsed = parseToolArguments(toolCall);
  const reason = normalizeReason(parsed);
  const followupText =
    '继续执行当前任务。强制规则：凡是“仅汇报进度”或“准备 stop/end_turn”，都必须先调用 CONTINUE execution（continue_execution，可传 {"reason":"progress_update"}）。进度汇报顺序必须是：1) 先调 continue_execution；2) 最多 5 行简短汇报；3) 立即继续真实动作。进度汇报后禁止 finish_reason=stop/end_turn；仅在任务真正完成后才允许最终总结。任何阻塞等待都优先改成 clock.schedule；若等待达到或超过 3 分钟，必须立即设置时钟。复杂提醒先把上下文和下一步清单写入当前工作目录下的 clock.md，提醒到达后先读该文件。clock.md 模板固定为：## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项。';

  return {
    flowId: FLOW_ID,
    finalize: async () => {
      const patched = injectToolOutput(ctx.base, toolCall, {
        ok: true,
        executed: true,
        noop: true,
        action: 'continue_execution',
        ...(reason ? { reason } : {}),
        message:
          'No-op acknowledged. continue_execution is mandatory before progress-only summaries or stop/end_turn. Do not emit finish_reason=stop/end_turn for progress-only updates. After summary, continue real actions immediately; server auto-followup keeps execution moving. Use clock.schedule for blocking waits, and for complex reminders write/read clock.md with template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项.'
      });
      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':continue_execution_followup',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops: [
                { op: 'preserve_tools' },
                { op: 'ensure_standard_tools' },
                { op: 'append_assistant_message', required: true },
                { op: 'append_tool_messages_from_tool_outputs', required: true }
              ]
            },
            metadata: {
              clientInjectOnly: true,
              clientInjectText: '继续执行',
              clientInjectSource: 'servertool.continue_execution'
            }
          }
        }
      };
    }
  };
};

registerServerToolHandler(TOOL_NAME, handler);
