import type { PipelineExecutionResult } from '../server/handlers/types.js';
import type { PreparedHttpRequest } from '../providers/core/runtime/http-request-executor.js';
import type { ProviderContext } from '../providers/core/api/provider-types.js';
import { writeProviderSnapshot } from '../providers/core/utils/snapshot-writer.js';

// feature_id: debug.pipeline_dry_run_loop

export const PIPELINE_DRY_RUN_HEADER = 'x-routecodex-dry-run';
export const PIPELINE_DRY_RUN_METADATA_KEY = '__routecodexPipelineDryRun';
export const PIPELINE_DRY_RUN_SERIALIZED_METADATA_KEY = '__rccDryRunSerialized';
export const PROVIDER_REQUEST_DRY_RUN_KIND = 'provider_request';

const PROVIDER_REQUEST_DRY_RUN_RESPONSE_SYMBOL = Symbol.for('routecodex.pipelineDryRun.providerRequestResponse');
const REDACTED_HEADER_VALUE = '[REDACTED]';
const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-routecodex-api-key',
  'x-routecodex-apikey',
  'api-key',
  'apikey',
  'cookie',
  'set-cookie'
]);

export type PipelineDryRunControl = {
  enabled: true;
  kind: typeof PROVIDER_REQUEST_DRY_RUN_KIND;
  source: 'local_header' | 'sample_replay' | 'diagnostic_route';
  requestedAtMs: number;
};

export type PipelineDryRunHeaderDecision =
  | { control?: PipelineDryRunControl }
  | { error: { status: number; body: Record<string, unknown> } };

export type ProviderRequestDryRunBody = {
  object: 'routecodex.pipeline_dry_run';
  kind: typeof PROVIDER_REQUEST_DRY_RUN_KIND;
  dryRun: true;
  requestId?: string;
  entryEndpoint?: string;
  entryPort?: number;
  provider: {
    providerKey?: string;
    providerId?: string;
    providerType?: string;
    providerFamily?: string;
    providerProtocol?: string;
    routeName?: string;
    runtimeKey?: string;
  };
  providerRequest: {
    method: 'POST';
    endpoint: string;
    url: string;
    urls?: string[];
    wantsSse: boolean;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  evidence: {
    stoppedBeforeProviderSend: true;
    providerRequestSnapshotWritten: true;
    logRequestId?: string;
  };
};

export type ProviderRequestDryRunResponse = PipelineExecutionResult & {
  body: ProviderRequestDryRunBody;
  [PROVIDER_REQUEST_DRY_RUN_RESPONSE_SYMBOL]: true;
};

function readHeaderValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) {
      continue;
    }
    if (typeof value === 'string') {
      return value.trim() || undefined;
    }
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim());
      return typeof first === 'string' ? first.trim() : undefined;
    }
  }
  return undefined;
}

export function hasPipelineDryRunHeader(headers: Record<string, unknown> | undefined): boolean {
  return readHeaderValue(headers, PIPELINE_DRY_RUN_HEADER) !== undefined;
}

export function resolvePipelineDryRunControlFromHeaders(args: {
  headers: Record<string, unknown> | undefined;
  isLocal: boolean;
  source?: PipelineDryRunControl['source'];
}): PipelineDryRunHeaderDecision {
  const raw = readHeaderValue(args.headers, PIPELINE_DRY_RUN_HEADER);
  if (!raw) {
    return {};
  }
  if (!args.isLocal) {
    return {
      error: {
        status: 403,
        body: {
          error: {
            message: 'pipeline dry-run is local-only',
            code: 'pipeline_dry_run_forbidden'
          }
        }
      }
    };
  }
  const normalized = raw.toLowerCase().replace(/-/g, '_');
  if (normalized !== PROVIDER_REQUEST_DRY_RUN_KIND && normalized !== 'request') {
    return {
      error: {
        status: 400,
        body: {
          error: {
            message: `unsupported pipeline dry-run mode: ${raw}`,
            code: 'pipeline_dry_run_bad_mode',
            supported: ['provider-request']
          }
        }
      }
    };
  }
  return {
    control: {
      enabled: true,
      kind: PROVIDER_REQUEST_DRY_RUN_KIND,
      source: args.source ?? 'local_header',
      requestedAtMs: Date.now()
    }
  };
}

export function attachPipelineDryRunControl(
  metadata: Record<string, unknown>,
  control: PipelineDryRunControl | undefined
): void {
  if (!control) {
    return;
  }
  Object.defineProperty(metadata, PIPELINE_DRY_RUN_METADATA_KEY, {
    value: { ...control },
    enumerable: false,
    configurable: true,
    writable: true
  });
  metadata[PIPELINE_DRY_RUN_SERIALIZED_METADATA_KEY] = { ...control };
}

export function propagatePipelineDryRunControl(
  source: unknown,
  target: Record<string, unknown>
): void {
  attachPipelineDryRunControl(target, readPipelineDryRunControl(source));
}

export function readPipelineDryRunControl(metadata: unknown): PipelineDryRunControl | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = Reflect.get(metadata as object, PIPELINE_DRY_RUN_METADATA_KEY);
  const serializedValue = Reflect.get(metadata as object, PIPELINE_DRY_RUN_SERIALIZED_METADATA_KEY);
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : serializedValue;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  return record.enabled === true && record.kind === PROVIDER_REQUEST_DRY_RUN_KIND
    ? (record as PipelineDryRunControl)
    : undefined;
}

export function shouldRunProviderRequestDryRun(context: ProviderContext): boolean {
  return readPipelineDryRunControl(context.runtimeMetadata?.metadata ?? context.metadata)?.kind === PROVIDER_REQUEST_DRY_RUN_KIND;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED_HEADER_VALUE : value;
  }
  return out;
}

function readEntryPortFromMetadata(metadata: Record<string, unknown> | undefined): number | undefined {
  if (!metadata) {
    return undefined;
  }
  for (const value of [metadata.entryPort, metadata.matchedPort, metadata.localPort, metadata.routecodexLocalPort]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
  }
  return undefined;
}

function readContextMetadata(context: ProviderContext): Record<string, unknown> | undefined {
  const runtimeMetadata =
    context.runtimeMetadata?.metadata
    && typeof context.runtimeMetadata.metadata === 'object'
    && !Array.isArray(context.runtimeMetadata.metadata)
      ? context.runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  const contextMetadata =
    context.metadata && typeof context.metadata === 'object' && !Array.isArray(context.metadata)
      ? context.metadata as Record<string, unknown>
      : undefined;
  if (runtimeMetadata && contextMetadata) {
    return {
      ...runtimeMetadata,
      ...contextMetadata
    };
  }
  return runtimeMetadata ?? contextMetadata;
}

function readEntryPortFromContext(context: ProviderContext): number | undefined {
  const runtimeMetadata =
    context.runtimeMetadata && typeof context.runtimeMetadata === 'object' && !Array.isArray(context.runtimeMetadata)
      ? context.runtimeMetadata as Record<string, unknown>
      : undefined;
  return readEntryPortFromMetadata(runtimeMetadata) ?? readEntryPortFromMetadata(readContextMetadata(context));
}

function readClientRequestIdFromContext(context: ProviderContext): string | undefined {
  const metadata = readContextMetadata(context);
  const candidate = metadata?.clientRequestId;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

export async function writeProviderRequestDryRunSnapshot(args: {
  requestInfo: PreparedHttpRequest;
  context: ProviderContext;
}): Promise<void> {
  const metadata = readContextMetadata(args.context);
  await writeProviderSnapshot({
    phase: 'provider-request',
    requestId: args.context.requestId,
    data: args.requestInfo.body,
    headers: args.requestInfo.headers,
    url: args.requestInfo.targetUrl,
    entryEndpoint: args.requestInfo.entryEndpoint,
    entryPort: readEntryPortFromContext(args.context),
    clientRequestId: readClientRequestIdFromContext(args.context),
    providerKey: args.context.providerKey,
    providerId: args.context.providerId,
    metadata
  });
}

export function buildProviderRequestDryRunResponse(args: {
  requestInfo: PreparedHttpRequest;
  context: ProviderContext;
}): ProviderRequestDryRunResponse {
  const metadata = readContextMetadata(args.context);
  const body: ProviderRequestDryRunBody = {
    object: 'routecodex.pipeline_dry_run',
    kind: PROVIDER_REQUEST_DRY_RUN_KIND,
    dryRun: true,
    requestId: args.context.requestId,
    entryEndpoint: args.requestInfo.entryEndpoint,
    entryPort: readEntryPortFromContext(args.context),
    provider: {
      providerKey: args.context.providerKey,
      providerId: args.context.providerId,
      providerType: args.context.providerType,
      providerFamily: args.context.providerFamily,
      providerProtocol: args.context.providerProtocol ?? args.context.runtimeMetadata?.providerProtocol,
      routeName: args.context.routeName ?? args.context.runtimeMetadata?.routeName,
      runtimeKey: args.context.runtimeMetadata?.runtimeKey
    },
    providerRequest: {
      method: 'POST',
      endpoint: args.requestInfo.endpoint,
      url: args.requestInfo.targetUrl,
      ...(args.requestInfo.targetUrls ? { urls: args.requestInfo.targetUrls } : {}),
      wantsSse: args.requestInfo.wantsSse,
      headers: redactHeaders(args.requestInfo.headers),
      body: args.requestInfo.body
    },
    evidence: {
      stoppedBeforeProviderSend: true,
      providerRequestSnapshotWritten: true,
      logRequestId: args.context.requestId
    }
  };
  const response: ProviderRequestDryRunResponse = {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-routecodex-dry-run': 'provider-request'
    },
    body,
    metadata: metadata ? { ...metadata } : undefined,
    [PROVIDER_REQUEST_DRY_RUN_RESPONSE_SYMBOL]: true
  };
  Object.defineProperty(response, PROVIDER_REQUEST_DRY_RUN_RESPONSE_SYMBOL, {
    value: true,
    enumerable: false,
    configurable: false
  });
  return response;
}

export function isProviderRequestDryRunResponse(value: unknown): value is ProviderRequestDryRunResponse {
  return Boolean(
    value
    && typeof value === 'object'
    && Reflect.get(value as object, PROVIDER_REQUEST_DRY_RUN_RESPONSE_SYMBOL) === true
  );
}

export function buildProviderRequestDryRunPipelineResult(args: {
  response: ProviderRequestDryRunResponse;
  metadata?: Record<string, unknown>;
  usageLogInfo?: PipelineExecutionResult['usageLogInfo'];
}): PipelineExecutionResult {
  const responseMetadata =
    args.response.metadata && typeof args.response.metadata === 'object' && !Array.isArray(args.response.metadata)
      ? args.response.metadata as Record<string, unknown>
      : {};
  return {
    status: args.response.status ?? 200,
    headers: args.response.headers,
    body: args.response.body,
    metadata: {
      ...responseMetadata,
      ...(args.metadata ?? {})
    },
    ...(args.usageLogInfo ? { usageLogInfo: args.usageLogInfo } : {})
  };
}
