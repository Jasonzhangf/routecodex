import type { ProviderContext } from '../api/provider-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { PreparedHttpRequest } from './http-request-executor.js';
import type { ProviderErrorAugmented } from './provider-error-types.js';
import { extractStatusCodeFromError } from './provider-error-classifier.js';
import { normalizeKnownProviderError, PROVIDER_NETWORK_CODES } from './provider-error-catalog.js';
import { applyProviderConfiguredErrorMapping } from './provider-configured-error-mapping.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';
import { readRuntimeRequestTruthPortNumber } from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';

function readSnapshotEntryPort(metadata?: Record<string, unknown>): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const requestTruthPort = readRuntimeRequestTruthPortNumber(metadata);
  if (typeof requestTruthPort === 'number') {
    return requestTruthPort;
  }
  for (const value of [
    metadata.portScope,
    metadata.entryPort,
    metadata.matchedPort,
    metadata.routecodexLocalPort,
    metadata.localPort
  ]) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

function readProviderContextSnapshotEntryPort(context: ProviderContext): number | undefined {
  const runtimeMetadataRecord =
    context.runtimeMetadata?.metadata && typeof context.runtimeMetadata.metadata === 'object' && !Array.isArray(context.runtimeMetadata.metadata)
      ? context.runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
  return readSnapshotEntryPort(runtimeMetadataRecord) ?? readSnapshotEntryPort(context.metadata);
}

function summarizeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'unknown_error';
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown_error');
  }
}

export async function normalizeProviderHttpError(options: {
  error: unknown;
  processedRequest: UnknownObject;
  requestInfo: PreparedHttpRequest;
  context: ProviderContext;
}): Promise<ProviderErrorAugmented> {
  const normalized: ProviderErrorAugmented = options.error as ProviderErrorAugmented;
  try {
    const statusCode = extractStatusCodeFromError(normalized);
    const mappedStatusCode = applyProviderConfiguredErrorMapping({
      normalized,
      context: options.context,
      statusCode
    });
    const effectiveStatusCode = mappedStatusCode ?? statusCode;
    const inferredCatalog = normalizeKnownProviderError({
      statusCode: effectiveStatusCode,
      code: normalized.code,
      upstreamCode: normalized.response?.data?.error?.code,
      message: normalized.message
    });
    if (effectiveStatusCode && !Number.isNaN(effectiveStatusCode)) {
      normalized.statusCode = effectiveStatusCode;
      if (!normalized.status) {
        normalized.status = effectiveStatusCode;
      }
      if (!normalized.code) {
        normalized.code = `HTTP_${effectiveStatusCode}`;
      }
    }
    if (inferredCatalog) {
      if (!normalized.code) {
        normalized.code = inferredCatalog.key;
      }
      if (
        (!normalized.statusCode || Number.isNaN(normalized.statusCode))
        && (!normalized.status || Number.isNaN(normalized.status))
      ) {
        if (typeof inferredCatalog.status === 'number') {
          normalized.statusCode = inferredCatalog.status;
          normalized.status = inferredCatalog.status;
        } else if (PROVIDER_NETWORK_CODES.has(inferredCatalog.key)) {
          normalized.statusCode = 502;
          normalized.status = 502;
        }
      }
    }
    if (!normalized.response) {
      normalized.response = {};
    }
    if (!normalized.response.data) {
      normalized.response.data = {};
    }
    if (!normalized.response.data.error) {
      normalized.response.data.error = {};
    }
    const mapped = Boolean(normalized.details?.providerErrorMapping);
    if (normalized.code && (mapped || !normalized.response.data.error.code)) {
      normalized.response.data.error.code = normalized.code;
    }
    if (normalized.message && (mapped || !normalized.response.data.error.message)) {
      normalized.response.data.error.message = normalized.message;
    }
    if (typeof normalized.status === 'number' && (mapped || !normalized.response.data.error.status)) {
      normalized.response.data.error.status = normalized.status;
    }
  } catch {
    // keep original error shape when normalization fails
  }

  try {
    await writeProviderSnapshot({
      phase: 'provider-error',
      requestId: options.context.requestId,
      data: {
        status: normalized?.statusCode ?? normalized?.status ?? null,
        code: normalized?.code ?? null,
        error: typeof normalized?.message === 'string' ? normalized.message : String(options.error || '')
      },
      headers: options.requestInfo.headers,
      url: options.requestInfo.targetUrl,
      entryEndpoint:
        options.requestInfo.entryEndpoint
        ?? ProviderPayloadUtils.extractEntryEndpointFromPayload(options.processedRequest),
      entryPort: readProviderContextSnapshotEntryPort(options.context),
      clientRequestId:
        options.requestInfo.clientRequestId
        ?? ProviderPayloadUtils.getClientRequestIdFromContext(options.context),
      providerKey: options.context.providerKey,
      providerId: options.context.providerId
    });
  } catch {
    // snapshot is best-effort only
  }

  return normalized;
}
