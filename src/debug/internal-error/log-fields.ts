import type { InternalDebugErrorCode } from './registry.js';
import { resolveInternalDebugErrorCodeForNodeId } from './registry.js';

export interface InternalDebugErrorLogFields {
  internalCode?: InternalDebugErrorCode;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readErrorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
}

export function resolveInternalDebugErrorLogFields(input: {
  error: unknown;
  summary: string;
}): InternalDebugErrorLogFields {
  const record = readErrorRecord(input.error);
  const nestedInternalError = readErrorRecord(record?.internalError);
  const details = readErrorRecord(record?.details);

  // 1. 直接 internalCode 字段（最高优先级）
  const directInternalCode =
    readTrimmedString(record?.internalCode)
    ?? readTrimmedString(details?.internalCode)
    ?? readTrimmedString(details?.internal_error)
    ?? readTrimmedString(input.summary.match(/internalCode[=:]\s*(500-[123]\d{2})/i)?.[1])
    ?? readTrimmedString(nestedInternalError?.internalCode);
  if (directInternalCode && /^500-[123]\d{2}$/.test(directInternalCode)) {
    return { internalCode: directInternalCode as InternalDebugErrorCode };
  }

  // 2. code 精确匹配
  const code =
    readTrimmedString(record?.code)
    ?? readTrimmedString(record?.errorCode)
    ?? input.summary.match(/\bcode=([A-Za-z0-9_.-]+)/i)?.[1];

  if (code === 'hub_pipeline_virtual_router_retry_route_failed') {
    return {
      internalCode: resolveInternalDebugErrorCodeForNodeId('VrRoute04SelectedTarget'),
    };
  }
  if (code === 'hub_pipeline_request_native_failed') {
    return {
      internalCode: resolveInternalDebugErrorCodeForNodeId('HubReqChatProcess03Governed'),
    };
  }
  if (code === 'hub_pipeline_response_native_failed') {
    return {
      internalCode: resolveInternalDebugErrorCodeForNodeId('HubRespChatProcess03Governed'),
    };
  }

  // 3. summary 关键字匹配
  if (input.summary.includes('VIRTUAL_ROUTER_ERROR:PROVIDER_NOT_AVAILABLE')) {
    return {
      internalCode: resolveInternalDebugErrorCodeForNodeId('VrRoute04SelectedTarget'),
    };
  }

  // 4. message 推断 — 在 input.summary 上匹配（summary 是 formatErrorForConsole 后的文本）
  //    注意 summary 可能已经被 mapErrorToPublicLogSummary 简化，但格式仍然保留原始 message
  //    如果 error.message 包含关键短语，在 formatErrorForConsole 后仍然会出现在 summary 中
  const summaryLower = input.summary.toLowerCase();
  if (summaryLower.includes('hubpipeline requires metadata center') || summaryLower.includes('metadata center runtime_control.providerprotocol')) {
    // "Provider response conversion requires metadata center" 也匹配 "metadata center runtime_control"
    // 但需要区分是 HubPipeline 还是 ProviderResponse
    // "hubpipeline requires" 只在 HubPipeline 场景出现
    // "provider response conversion" 是 response 侧
    if (summaryLower.includes('hubpipeline requires') || (!summaryLower.includes('provider response conversion') && !summaryLower.includes('provider response converter'))) {
      return {
        internalCode: resolveInternalDebugErrorCodeForNodeId('HubReqInbound02Standardized'),
      };
    }
    if (summaryLower.includes('provider response conversion') || summaryLower.includes('provider response converter')) {
      return {
        internalCode: resolveInternalDebugErrorCodeForNodeId('HubRespInbound02Parsed'),
      };
    }
  }

  // 5. 用 error.message 做二次匹配
  if (record?.message) {
    const message = String(record.message).toLowerCase();
    if (message.includes('provider response conversion requires metadata center')) {
      return {
        internalCode: resolveInternalDebugErrorCodeForNodeId('HubRespInbound02Parsed'),
      };
    }
    if (message.includes('rust hubpipeline response path failed')) {
      return {
        internalCode: resolveInternalDebugErrorCodeForNodeId('HubRespChatProcess03Governed'),
      };
    }
  }

  return {};
}
