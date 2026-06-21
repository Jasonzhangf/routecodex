import type { ProviderContext } from '../api/provider-types.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';

export type ProviderErrorMappingRule = {
  origin: {
    status?: number;
    code?: string;
    upstreamCode?: string;
    error?: {
      code?: string;
      type?: string;
      param?: string;
      messageContains?: string;
      messageEquals?: string;
    };
  };
  to: {
    status?: number;
    code?: string;
    message?: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseRawErrorBody(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf('{');
  const source = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  try {
    return asRecord(JSON.parse(source));
  } catch {
    return undefined;
  }
}

function getRuntimeExtensions(context: ProviderContext): Record<string, unknown> | undefined {
  const runtime = asRecord(context.runtimeMetadata);
  const runtimeExtensions = asRecord(runtime?.extensions);
  if (runtimeExtensions) {
    return runtimeExtensions;
  }
  const contextExtensions = asRecord(context.extensions);
  if (contextExtensions) {
    return contextExtensions;
  }
  const profileExtensions = asRecord(context.profile?.extensions);
  if (profileExtensions) {
    return profileExtensions;
  }
  const target = asRecord(context.target);
  return asRecord(target?.extensions);
}

export function readProviderErrorMappingRules(context: ProviderContext): ProviderErrorMappingRule[] {
  const extensions = getRuntimeExtensions(context);
  const errorMapping = asRecord(extensions?.errorMapping);
  const rules = Array.isArray(errorMapping?.rules) ? errorMapping.rules : [];
  const normalized: ProviderErrorMappingRule[] = [];
  for (const rawRule of rules) {
    const rule = asRecord(rawRule);
    const origin = asRecord(rule?.origin);
    const to = asRecord(rule?.to);
    if (!origin || !to) {
      continue;
    }
    normalized.push({
      origin: {
        status: readFiniteNumber(origin.status),
        code: readString(origin.code),
        upstreamCode: readString(origin.upstreamCode),
        error: asRecord(origin.error) as ProviderErrorMappingRule['origin']['error']
      },
      to: {
        status: readFiniteNumber(to.status),
        code: readString(to.code),
        message: readString(to.message)
      }
    });
  }
  return normalized;
}

function extractUpstreamErrorNode(error: ProviderErrorAugmented): Record<string, unknown> | undefined {
  const data = asRecord(error.response?.data);
  const dataError = asRecord(data?.error);
  if (dataError && (
    typeof dataError.message === 'string'
    || typeof dataError.type === 'string'
    || typeof dataError.param === 'string'
  )) {
    return dataError;
  }
  const parsedRaw = parseRawErrorBody(error.response?.raw);
  const rawError = asRecord(parsedRaw?.error);
  if (rawError) {
    return rawError;
  }
  const parsedMessage = parseRawErrorBody(error.message);
  return asRecord(parsedMessage?.error) ?? dataError;
}

function providerErrorMappingRuleMatches(args: {
  rule: ProviderErrorMappingRule;
  statusCode?: number;
  error: ProviderErrorAugmented;
  upstreamError?: Record<string, unknown>;
}): boolean {
  const { rule, statusCode, error, upstreamError } = args;
  if (rule.origin.status !== undefined && rule.origin.status !== statusCode) {
    return false;
  }
  if (rule.origin.code && rule.origin.code !== error.code) {
    return false;
  }
  const upstreamCode = readString(upstreamError?.code);
  if (rule.origin.upstreamCode && rule.origin.upstreamCode !== upstreamCode) {
    return false;
  }
  const originError = rule.origin.error;
  if (!originError) {
    return true;
  }
  if (originError.code && originError.code !== upstreamCode) {
    return false;
  }
  if (originError.type && originError.type !== readString(upstreamError?.type)) {
    return false;
  }
  if (originError.param && originError.param !== readString(upstreamError?.param)) {
    return false;
  }
  const upstreamMessage = readString(upstreamError?.message) ?? error.message ?? '';
  if (originError.messageEquals && upstreamMessage !== originError.messageEquals) {
    return false;
  }
  if (originError.messageContains && !upstreamMessage.includes(originError.messageContains)) {
    return false;
  }
  return true;
}

export function applyProviderConfiguredErrorMapping(args: {
  normalized: ProviderErrorAugmented;
  context: ProviderContext;
  statusCode?: number;
}): number | undefined {
  const rules = readProviderErrorMappingRules(args.context);
  if (rules.length === 0) {
    return undefined;
  }
  const upstreamError = extractUpstreamErrorNode(args.normalized);
  for (const rule of rules) {
    if (!providerErrorMappingRuleMatches({
      rule,
      statusCode: args.statusCode,
      error: args.normalized,
      upstreamError
    })) {
      continue;
    }
    const originalStatus = args.statusCode ?? args.normalized.statusCode ?? args.normalized.status ?? null;
    const originalCode = args.normalized.code ?? null;
    const originalMessage = args.normalized.message ?? null;
    const mappedStatus = rule.to.status;
    const mappedCode = rule.to.code;
    const mappedMessage = rule.to.message ?? readString(upstreamError?.message);
    if (mappedStatus !== undefined) {
      args.normalized.statusCode = mappedStatus;
      args.normalized.status = mappedStatus;
    }
    if (mappedCode) {
      args.normalized.code = mappedCode;
    }
    if (mappedMessage) {
      args.normalized.message = mappedMessage;
    }
    if (!args.normalized.response) {
      args.normalized.response = {};
    }
    if (!args.normalized.response.data) {
      args.normalized.response.data = {};
    }
    if (!args.normalized.response.data.error) {
      args.normalized.response.data.error = {};
    }
    if (mappedCode) {
      args.normalized.response.data.error.code = mappedCode;
    }
    if (mappedMessage) {
      args.normalized.response.data.error.message = mappedMessage;
    }
    if (mappedStatus !== undefined) {
      args.normalized.response.data.error.status = mappedStatus;
      args.normalized.response.status = mappedStatus;
    }
    args.normalized.details = {
      ...(args.normalized.details ?? {}),
      providerErrorMapping: {
        originalStatus,
        originalCode,
        originalMessage,
        mappedStatus: mappedStatus ?? null,
        mappedCode: mappedCode ?? null
      }
    };
    return mappedStatus;
  }
  return undefined;
}
