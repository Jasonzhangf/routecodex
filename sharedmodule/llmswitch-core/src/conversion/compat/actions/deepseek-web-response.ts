import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { type TextMarkupNormalizeOptions } from '../../shared/text-markup-normalizer.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeRespInboundStage3CompatInput
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { runRespInboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import {
  isNativeDisabledByEnv,
  makeNativeRequiredError
} from '../../../router/virtual-router/engine-selection/native-router-hotpath-policy.js';
import { providerErrorCenter } from '../../../router/virtual-router/error-center.js';

type UnknownRecord = Record<string, unknown>;
type DeepSeekToolProtocol = 'native' | 'text';

export interface DeepSeekWebResponseConfig {
  strictToolRequired?: boolean;
  textNormalizer?: TextMarkupNormalizeOptions;
  toolProtocol?: DeepSeekToolProtocol;
}

const PROFILE = 'chat:deepseek-web';
const DEFAULT_PROVIDER_PROTOCOL = 'openai-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1/chat/completions';

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
};

const readToolProtocol = (value: unknown): DeepSeekToolProtocol | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'native' || normalized === 'text' ? normalized : undefined;
};

function buildRuntimeMetadata(
  adapterContext?: AdapterContext,
  payload?: JsonObject,
  details?: Record<string, unknown>
): Record<string, unknown> {
  const contextRecord = adapterContext && typeof adapterContext === 'object'
    ? (adapterContext as Record<string, unknown>)
    : undefined;
  const runtime: Record<string, unknown> = {};
  const assignString = (key: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      runtime[key] = value.trim();
    }
  };

  assignString('requestId', contextRecord?.requestId);
  assignString('providerProtocol', contextRecord?.providerProtocol);
  assignString('providerId', contextRecord?.providerId);
  assignString('providerKey', contextRecord?.providerKey);
  assignString('runtimeKey', contextRecord?.runtimeKey);
  assignString('routeName', contextRecord?.routeId);
  assignString('pipelineId', PROFILE);

  if (payload && typeof payload === 'object') {
    assignString('target', (payload as Record<string, unknown>).model);
  }

  if (details && Object.keys(details).length > 0) {
    runtime.details = details;
  }

  return runtime;
}

function emitCompatError(
  error: Error,
  adapterContext?: AdapterContext,
  payload?: JsonObject,
  details?: Record<string, unknown>
): never {
  providerErrorCenter.emit({
    code: 'DEEPSEEK_WEB_COMPAT_ERROR',
    message: error.message,
    stage: 'compat:deepseek-web-response',
    runtime: buildRuntimeMetadata(adapterContext, payload, details),
    details: {
      compatibilityProfile: PROFILE,
      ...(details ?? {})
    }
  } as any);
  throw error;
}

function resolveDeepseekNode(
  adapterContext?: AdapterContext,
  config?: DeepSeekWebResponseConfig
): Record<string, unknown> {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const baseNode = isRecord(nativeContext.deepseek) ? nativeContext.deepseek : {};
  const configProtocol = readToolProtocol(config?.toolProtocol);
  const baseProtocol = readToolProtocol(baseNode.toolProtocol);
  const baseFallback = readBoolean(baseNode.textToolFallback);
  const protocol =
    configProtocol ??
    baseProtocol ??
    (baseFallback === undefined ? undefined : baseFallback ? 'text' : 'native');

  return {
    ...baseNode,
    strictToolRequired: config?.strictToolRequired ?? readBoolean(baseNode.strictToolRequired) ?? true,
    textToolFallback: protocol ? protocol === 'text' : baseFallback ?? true,
    ...(protocol ? { toolProtocol: protocol } : {})
  };
}

function buildCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext,
  config?: DeepSeekWebResponseConfig
): NativeRespInboundStage3CompatInput {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const normalizedContext: NativeReqOutboundCompatAdapterContextInput = {
    ...nativeContext,
    compatibilityProfile: PROFILE,
    providerProtocol: nativeContext.providerProtocol ?? adapterContext?.providerProtocol ?? DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint: nativeContext.entryEndpoint ?? adapterContext?.entryEndpoint ?? DEFAULT_ENTRY_ENDPOINT,
    deepseek: resolveDeepseekNode(adapterContext, config)
  };

  return {
    payload,
    adapterContext: normalizedContext,
    explicitProfile: PROFILE
  };
}

export function applyDeepSeekWebResponseTransform(
  payload: JsonObject,
  adapterContext?: AdapterContext,
  config?: DeepSeekWebResponseConfig
): JsonObject {
  if (!payload || typeof payload !== 'object') {
    emitCompatError(new Error('[deepseek-web] invalid compat payload: expected object'), adapterContext, payload, {
      reason: 'payload is not an object'
    });
  }

  // Fail fast if response is missing required shape (choices array)
  if (!Array.isArray((payload as any).choices)) {
    // Allow business error format (code + msg) to pass through for separate handling
    if (!('code' in payload && 'msg' in payload)) {
      emitCompatError(
        new Error('[deepseek-web] invalid response: missing required "choices" array'),
        adapterContext,
        payload,
        { reason: 'missing required response shape' }
      );
    }
  }

  if (isNativeDisabledByEnv()) {
    emitCompatError(
      makeNativeRequiredError('runRespInboundStage3CompatJson', 'native disabled'),
      adapterContext,
      payload,
      { reason: 'native disabled' }
    );
  }

  try {
    return runRespInboundStage3CompatWithNative(buildCompatInput(payload, adapterContext, config)).payload;
  } catch (error) {
    const compatError = error instanceof Error ? error : new Error(String(error));
    emitCompatError(compatError, adapterContext, payload, {
      reason: 'native compat execution failed'
    });
  }
}
