import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan
} from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { isCompactionRequest } from './compaction-detect.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';

const FLOW_ID = 'iflow_model_error_retry';

const handler: ServerToolHandler = async (
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | null> => {
  if (!ctx.capabilities.reenterPipeline) {
    return null;
  }

  const adapterRecord = ctx.adapterContext as unknown as {
    providerKey?: unknown;
  };
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);

  // 避免在 followup 请求里再次触发，防止循环。
  const followupRaw = (rt as any)?.serverToolFollowup;
  if (followupRaw === true || (typeof followupRaw === 'string' && followupRaw.trim().toLowerCase() === 'true')) {
    return null;
  }
  if (hasCompactionFlag(rt)) {
    return null;
  }

  // 仅针对 openai-chat 协议 + iflow.* providerKey 的 /v1/responses 路径启用。
  if (ctx.providerProtocol !== 'openai-chat') {
    return null;
  }
  const entryEndpoint = (ctx.entryEndpoint || '').toLowerCase();
  if (!entryEndpoint.includes('/v1/responses')) {
    return null;
  }
  const providerKey =
    typeof adapterRecord.providerKey === 'string' && adapterRecord.providerKey.trim()
      ? adapterRecord.providerKey.trim().toLowerCase()
      : '';
  if (!providerKey.startsWith('iflow.')) {
    return null;
  }

  // 仅在上游返回 error_code（HTTP 200 + 业务错误）时触发一次自动重试。
  const base = ctx.base as { [key: string]: unknown };
  const errorCode = base.error_code;
  const msg = base.msg;
  if (typeof errorCode !== 'number' || errorCode === 0) {
    return null;
  }
  if (typeof msg !== 'string' || !msg.trim().length) {
    return null;
  }

  const captured = getCapturedRequest(ctx.adapterContext);
  if (!captured) {
    return null;
  }
  if (isCompactionRequest(captured)) {
    return null;
  }
  const seed = extractCapturedChatSeed(captured);
  if (!seed) {
    return null;
  }

  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: ctx.base,
      execution: {
        flowId: FLOW_ID,
        followup: {
          requestIdSuffix: ':retry',
          entryEndpoint: ctx.entryEndpoint,
          injection: {
            ops: []
          }
        }
      }
    })
  };
};

registerServerToolHandler('iflow_model_error_retry', handler, { trigger: 'auto', hook: { phase: 'pre', priority: 10 } });

function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const captured = (adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    return null;
  }
  return captured as JsonObject;
}

function hasCompactionFlag(rt: unknown): boolean {
  const flag = rt && typeof rt === 'object' && !Array.isArray(rt) ? (rt as any).compactionRequest : undefined;
  if (flag === true) {
    return true;
  }
  if (typeof flag === 'string' && flag.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}
