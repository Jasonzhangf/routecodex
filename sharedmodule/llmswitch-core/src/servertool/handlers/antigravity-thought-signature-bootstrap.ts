import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { cloneJson } from '../server-side-tools.js';

const FLOW_ID = 'antigravity_thought_signature_bootstrap';

type ErrorInfo = { status?: number; code?: string; message?: string };

function readProviderKey(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return '';
  }
  const raw = (adapterContext as any).providerKey ?? (adapterContext as any).runtimeKey ?? (adapterContext as any).providerId;
  return typeof raw === 'string' ? raw.trim() : '';
}

function isAntigravityFamily(providerKey: string): boolean {
  const lowered = providerKey.toLowerCase();
  return lowered.startsWith('antigravity.') || lowered.startsWith('gemini-cli.');
}

function readErrorInfo(base: JsonObject): ErrorInfo | null {
  const err = (base as any).error;
  if (!err || typeof err !== 'object' || Array.isArray(err)) {
    return null;
  }
  const codeRaw = (err as any).code;
  const msgRaw = (err as any).message;
  const statusRaw = (err as any).status ?? (err as any).statusCode;
  const code = typeof codeRaw === 'string' ? codeRaw.trim() : typeof codeRaw === 'number' ? String(codeRaw) : undefined;
  const message = typeof msgRaw === 'string' ? msgRaw.trim() : undefined;
  const status =
    typeof statusRaw === 'number' && Number.isFinite(statusRaw)
      ? Math.floor(statusRaw)
      : typeof code === 'string' && /^HTTP_\d{3}$/i.test(code)
        ? Number(code.split('_')[1])
        : typeof code === 'string' && /^\d{3}$/.test(code)
          ? Number(code)
          : undefined;
  return { ...(status ? { status } : {}), ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function isSignatureInvalidError(error: ErrorInfo): boolean {
  const code = (error.code || '').toLowerCase();
  if (code.includes('signature')) {
    return true;
  }
  const msg = (error.message || '').toLowerCase();
  return msg.includes('signature') && (msg.includes('invalid') || msg.includes('corrupt') || msg.includes('validator'));
}

function shouldTriggerBootstrap(error: ErrorInfo): boolean {
  // One-shot bootstrap trigger:
  // - Always attempt once on 429 (may be quota OR signature validator; one-shot prevents loops).
  // - Also attempt on 400 when we can confidently classify as signature invalid/missing.
  if (error.status === 429) return true;
  if (error.status === 400 && isSignatureInvalidError(error)) return true;
  return false;
}

function buildClockToolSchema(): JsonObject {
  // Keep this schema aligned with docs/SERVERTOOL_CLOCK_DESIGN.md + chat-process injection.
  return {
    type: 'function',
    function: {
      name: 'clock',
      description:
        'Time + Alarm for this session. Mandatory workflow: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If two reminders would be within 5 minutes, merge or retime them instead of keeping near-duplicate alarms. Use clock.schedule for any blocking wait so work can continue non-blockingly and you will get an interrupt reminder later. If waiting 3 minutes or longer is required, call clock.schedule now (do not only promise to wait). You may set multiple reminders when they are meaningfully different. For complex reminders, write clock.md before waiting and read it first when reminded. Required clock.md template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项. Format example: {"action":"list","items":[],"taskId":""} before {"action":"schedule","items":[{"dueAt":"<ISO8601>","task":"<exact follow-up action>","tool":"<tool-name-or-empty>","arguments":"<json-string-or-{}>"}],"taskId":""}. Use get/schedule/update/list/cancel/clear. Scheduled reminders will be injected into future requests.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get', 'schedule', 'update', 'list', 'cancel', 'clear'],
              description:
              'Get current time, or schedule/update/list/cancel/clear session-scoped reminders. Mandatory rule: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If reminders end up within 5 minutes of each other, reconsider and merge or retime them. Use clock.schedule for blocking waits that should not stall execution. If waiting 3 minutes or longer is required, use action="schedule" immediately. For complex reminders, write the context into clock.md using this template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项.'
          },
          items: {
            type: 'array',
            description: 'For schedule/update: list of reminders (update uses items[0]).',
            items: {
              type: 'object',
              properties: {
                dueAt: {
                  type: 'string',
                  description: 'ISO8601 datetime with timezone (e.g. 2026-01-21T20:30:00-08:00).'
                },
                task: {
                  type: 'string',
                  description: 'Reminder text (should include which tool to use and what to do).'
                },
                tool: {
                  type: 'string',
                  description: 'Optional suggested tool name (hint only).'
                },
                arguments: {
                  type: 'string',
                  description: 'Optional suggested tool arguments as a JSON string (hint only). Use "{}" when unsure.'
                }
              },
              required: ['dueAt', 'task', 'tool', 'arguments'],
              additionalProperties: false
            }
          },
          taskId: {
            type: 'string',
            description: 'For cancel/update: taskId to target.'
          }
        },
        required: ['action', 'items', 'taskId'],
        additionalProperties: false
      }
    }
  } as JsonObject;
}

function ensureClockTool(tools: JsonObject[] | undefined): JsonObject[] {
  const list = Array.isArray(tools) ? (cloneJson(tools) as JsonObject[]) : [];
  const hasClock = list.some((tool) => {
    const fn = tool && typeof tool === 'object' && !Array.isArray(tool) ? (tool as any).function : undefined;
    const name = fn && typeof fn === 'object' && typeof (fn as any).name === 'string' ? String((fn as any).name) : '';
    return name.trim() === 'clock';
  });
  if (hasClock) {
    return list;
  }
  return [...list, buildClockToolSchema()];
}

const BOOTSTRAP_USER_PROMPT =
  '请先调用 `clock` 工具并传入 `{\"action\":\"get\",\"items\":[],\"taskId\":\"\"}` 获取当前时间；' +
  '得到工具返回后只需回复 `OK`（不要调用其它工具）。';

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  if (!ctx.capabilities.reenterPipeline) {
    return null;
  }
  if (ctx.providerProtocol !== 'gemini-chat') {
    return null;
  }
  const providerKey = readProviderKey(ctx.adapterContext);
  if (!providerKey || !isAntigravityFamily(providerKey)) {
    return null;
  }

  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  if ((rt as any)?.serverToolFollowup === true) {
    return null;
  }
  if ((rt as any)?.antigravityThoughtSignatureBootstrapAttempted === true) {
    return null;
  }

  const error = readErrorInfo(ctx.base);
  if (!error || !shouldTriggerBootstrap(error)) {
    return null;
  }

  const captured = (ctx.adapterContext as any)?.capturedChatRequest;
  const seed = extractCapturedChatSeed(captured);
  if (!seed) {
    return null;
  }

  // Preflight bootstrap request:
  // - Avoid any historical tool calls so Gemini can emit a fresh thoughtSignature.
  // - Keep the FIRST user message identical to the original request to preserve derived session_id.
  const originalMessages = Array.isArray(seed.messages) ? (cloneJson(seed.messages) as JsonObject[]) : [];
  const firstUser = originalMessages.find((m) => {
    const role = typeof (m as any)?.role === 'string' ? String((m as any).role).toLowerCase() : '';
    return role === 'user';
  });
  if (!firstUser) {
    return null;
  }
  const messages: JsonObject[] = [cloneJson(firstUser) as JsonObject, { role: 'user', content: BOOTSTRAP_USER_PROMPT } as JsonObject];

  const parameters: JsonObject = {
    ...(seed.parameters && typeof seed.parameters === 'object' && !Array.isArray(seed.parameters)
      ? (cloneJson(seed.parameters) as unknown as JsonObject)
      : {})
  };
  // Gemini toolConfig forcing: request the model to emit a clock call first, before any other tools.
  parameters.tool_config = {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: ['clock']
    }
  };

  const followupPayload: JsonObject = {
    ...(seed.model ? { model: seed.model } : {}),
    messages,
    tools: ensureClockTool([]),
    ...(Object.keys(parameters).length ? { parameters } : {})
  };

  const followupMetadata: JsonObject = {
    __shadowCompareForcedProviderKey: providerKey
  };
  const followupRt = ensureRuntimeMetadata(followupMetadata as unknown as Record<string, unknown>);
  (followupRt as any).antigravityThoughtSignatureBootstrap = true;
  (followupRt as any).antigravityThoughtSignatureBootstrapAttempted = true;

  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: ctx.base,
      execution: {
        flowId: FLOW_ID,
        followup: {
          requestIdSuffix: ':antigravity_ts_bootstrap',
          entryEndpoint: ctx.entryEndpoint,
          payload: followupPayload,
          metadata: followupMetadata
        }
      }
    })
  };
};

registerServerToolHandler(FLOW_ID, handler, { trigger: 'auto', hook: { phase: 'default', priority: 30 } });
