import type { UnknownObject } from '../../../../types/common-types.js';
import type { ProviderContext } from '../../api/provider-types.js';
import type { ProviderRuntimeMetadata } from '../provider-runtime-metadata.js';
import { extractProviderRuntimeMetadata } from '../provider-runtime-metadata.js';

type ResponseRecord = Record<string, unknown> & {
  data?: ResponseRecord;
  model?: string;
  usage?: UnknownObject;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export class ProviderPayloadUtils {
  static asResponseRecord(value: unknown): ResponseRecord {
    if (isRecord(value)) {
      return value as ResponseRecord;
    }
    return {};
  }

  static extractModel(record: ResponseRecord): string | undefined {
    if (typeof record.model === 'string' && record.model.trim()) {
      return record.model;
    }
    if (record.data && typeof record.data.model === 'string' && record.data.model.trim()) {
      return record.data.model;
    }
    return undefined;
  }

  static extractUsage(record: ResponseRecord): UnknownObject | undefined {
    if (record.usage && typeof record.usage === 'object') {
      return record.usage as UnknownObject;
    }
    if (record.data && record.data.usage && typeof record.data.usage === 'object') {
      return record.data.usage as UnknownObject;
    }
    return undefined;
  }

  static getClientRequestIdFromContext(context: ProviderContext): string | undefined {
    const fromMetadata = ProviderPayloadUtils.extractClientId(context.metadata);
    if (fromMetadata) {
      return fromMetadata;
    }
    const runtimeMeta = context.runtimeMetadata?.metadata;
    return ProviderPayloadUtils.extractClientId(runtimeMeta as Record<string, unknown> | undefined);
  }

  static extractClientId(source: Record<string, unknown> | undefined): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const value = (source as Record<string, unknown>).clientRequestId;
    if (typeof value === 'string' && value.trim().length) {
      return value.trim();
    }
    return undefined;
  }

  static buildClientMetadata(_runtimeMetadata?: Record<string, unknown> | undefined): string {
    return 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI';
  }

  static buildRequestType(runtimeMetadata?: Record<string, unknown> | undefined): string | undefined {
    const model = runtimeMetadata?.target as { clientModelId?: string } | undefined;
    const modelId = model?.clientModelId || '';

    if (modelId.includes('image') || modelId.includes('imagen')) {
      return 'image_gen';
    }

    return 'agent';
  }

  static normalizeClientHeaders(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const normalized: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string' && raw.trim()) {
        normalized[key] = raw;
      }
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }

  static extractEntryEndpointFromPayload(payload: UnknownObject): string | undefined {
    const runtimeMeta = extractProviderRuntimeMetadata(payload as Record<string, unknown>);
    const metadata = (runtimeMeta && typeof runtimeMeta.metadata === 'object')
      ? (runtimeMeta.metadata as Record<string, unknown>)
      : (payload as { metadata?: Record<string, unknown> }).metadata;
    if (metadata && typeof metadata.entryEndpoint === 'string' && metadata.entryEndpoint.trim()) {
      return metadata.entryEndpoint;
    }
    return undefined;
  }

  static extractEntryEndpointFromRuntime(runtime?: ProviderRuntimeMetadata): string | undefined {
    if (!runtime || !runtime.metadata || typeof runtime.metadata !== 'object') {
      return undefined;
    }
    const meta = runtime.metadata as Record<string, unknown>;
    const value = meta.entryEndpoint;
    return typeof value === 'string' && value.trim().length ? value : undefined;
  }
}
