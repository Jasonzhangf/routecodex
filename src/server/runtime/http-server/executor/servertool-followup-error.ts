import { asRecord } from '../provider-utils.js';

const FOLLOWUP_LOG_REASON_MAX_LEN = 180;

export function compactFollowupLogReason(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  const httpMatch =
    normalized.match(/^http\s+(\d{3})\s*:/i) ||
    normalized.match(/\bhttp\s+(\d{3})\b/i);
  if (httpMatch?.[1]) {
    return `HTTP_${httpMatch[1]}`;
  }
  if (/<\s*!doctype\s+html\b/i.test(normalized) || /<\s*html\b/i.test(normalized)) {
    return 'UPSTREAM_HTML_ERROR';
  }
  if (normalized.length <= FOLLOWUP_LOG_REASON_MAX_LEN) {
    return normalized;
  }
  return `${normalized.slice(0, FOLLOWUP_LOG_REASON_MAX_LEN)}…`;
}

export function isServerToolFollowupError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  return Boolean(
    code === 'SERVERTOOL_FOLLOWUP_FAILED' ||
      code === 'SERVERTOOL_EMPTY_FOLLOWUP' ||
      (typeof code === 'string' && code.startsWith('SERVERTOOL_'))
  );
}

export function extractServerToolFollowupErrorLogDetails(error: unknown): {
  code?: string;
  upstreamCode?: string;
  reason?: string;
} {
  if (!error || typeof error !== 'object') {
    return {};
  }
  const errRecord = error as Record<string, unknown>;
  const errCode = typeof errRecord.code === 'string' ? errRecord.code : undefined;
  const upstreamCode = typeof errRecord.upstreamCode === 'string' ? errRecord.upstreamCode : undefined;
  const detailRecord = asRecord(errRecord.details);
  const detailReason =
    typeof detailRecord?.reason === 'string'
      ? detailRecord.reason
      : typeof detailRecord?.error === 'string'
        ? detailRecord.error
        : undefined;
  const detailUpstreamCode =
    typeof detailRecord?.upstreamCode === 'string'
      ? detailRecord.upstreamCode
      : undefined;

  return {
    ...(compactFollowupLogReason(errCode) || errCode ? { code: compactFollowupLogReason(errCode) || errCode } : {}),
    ...(compactFollowupLogReason(upstreamCode || detailUpstreamCode)
      ? { upstreamCode: compactFollowupLogReason(upstreamCode || detailUpstreamCode) }
      : {}),
    ...(compactFollowupLogReason(detailReason) || compactFollowupLogReason((error as Error)?.message)
      ? { reason: compactFollowupLogReason(detailReason) || compactFollowupLogReason((error as Error)?.message) }
      : {})
  };
}


export function finalizeServerToolFollowupConvertError(args: {
  error: unknown;
  requestId: string;
  defaultStatus?: number;
  message?: string;
}): {
  matched: boolean;
  stageDetails?: {
    code?: string;
    upstreamCode?: string;
    reason?: string;
    message?: string;
  };
} {
  const matched = markServerToolFollowupError({
    error: args.error,
    requestId: args.requestId,
    defaultStatus: args.defaultStatus
  });
  if (!matched) {
    return { matched: false };
  }
  const logDetails = extractServerToolFollowupErrorLogDetails(args.error);
  return {
    matched: true,
    stageDetails: {
      ...(logDetails.code ? { code: logDetails.code } : {}),
      ...(logDetails.upstreamCode ? { upstreamCode: logDetails.upstreamCode } : {}),
      ...(logDetails.reason ? { reason: logDetails.reason } : {}),
      ...(args.message ? { message: args.message } : {})
    }
  };
}

export function finalizeServerToolBridgeConvertError(args: {
  error: unknown;
  requestId: string;
  message: string;
  defaultFollowupStatus?: number;
  isSseDecodeError?: boolean;
  isContextLengthExceeded?: boolean;
  code?: string;
  upstreamCode?: string;
  detailUpstreamCode?: string;
  detailReason?: string;
}): {
  handled: boolean;
  stageDetails?: {
    code?: string;
    upstreamCode?: string;
    reason?: string;
    message?: string;
  };
} {
  const followupPlan = finalizeServerToolFollowupConvertError({
    error: args.error,
    requestId: args.requestId,
    defaultStatus: args.defaultFollowupStatus,
    message: args.message
  });
  if (followupPlan.matched) {
    return {
      handled: true,
      stageDetails: followupPlan.stageDetails
    };
  }

  if (!args.isSseDecodeError && !args.isContextLengthExceeded) {
    return { handled: false };
  }

  if (args.isSseDecodeError && args.error && typeof args.error === 'object') {
    (args.error as Record<string, unknown>).requestExecutorProviderErrorStage = 'provider.sse_decode';
  }

  const normalizedCode =
    typeof (args.error as { code?: unknown } | undefined)?.code === 'string'
      ? String((args.error as { code?: string }).code)
      : args.code;

  return {
    handled: true,
    stageDetails: {
      ...(normalizedCode ? { code: normalizedCode } : {}),
      ...((args.upstreamCode || args.detailUpstreamCode)
        ? { upstreamCode: args.upstreamCode || args.detailUpstreamCode }
        : {}),
      ...(compactFollowupLogReason(args.detailReason)
        ? { reason: compactFollowupLogReason(args.detailReason) }
        : {}),
      message: args.message
    }
  };
}

export function markServerToolFollowupError(args: {
  error: unknown;
  requestId: string;
  defaultStatus?: number;
}): boolean {
  if (!isServerToolFollowupError(args.error) || !args.error || typeof args.error !== 'object') {
    return false;
  }
  const errRecord = args.error as Record<string, unknown>;
  errRecord.requestExecutorProviderErrorStage = 'provider.followup';

  if (
    typeof args.defaultStatus === 'number' &&
    typeof errRecord.status !== 'number' &&
    typeof errRecord.statusCode !== 'number'
  ) {
    errRecord.status = args.defaultStatus;
    errRecord.statusCode = args.defaultStatus;
  }

  return true;
}
