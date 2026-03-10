import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStage3CompatInput
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

type UnknownRecord = Record<string, unknown>;
type DeepSeekToolProtocol = 'native' | 'text';

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

function resolveDeepseekNode(adapterContext?: AdapterContext): Record<string, unknown> {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const baseNode = isRecord(nativeContext.deepseek) ? nativeContext.deepseek : {};
  const baseProtocol = readToolProtocol(baseNode.toolProtocol);
  const baseFallback = readBoolean(baseNode.textToolFallback);
  const protocol =
    baseProtocol ?? (baseFallback === undefined ? undefined : baseFallback ? 'text' : 'native');

  return {
    ...baseNode,
    strictToolRequired: readBoolean(baseNode.strictToolRequired) ?? true,
    textToolFallback: protocol ? protocol === 'text' : baseFallback ?? true,
    ...(protocol ? { toolProtocol: protocol } : {})
  };
}

function buildCompatInput(
  payload: JsonObject,
  adapterContext?: AdapterContext
): NativeReqOutboundStage3CompatInput {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const normalizedContext: NativeReqOutboundCompatAdapterContextInput = {
    ...nativeContext,
    compatibilityProfile: PROFILE,
    providerProtocol: nativeContext.providerProtocol ?? adapterContext?.providerProtocol ?? DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint: nativeContext.entryEndpoint ?? adapterContext?.entryEndpoint ?? DEFAULT_ENTRY_ENDPOINT,
    deepseek: resolveDeepseekNode(adapterContext)
  };

  return {
    payload,
    adapterContext: normalizedContext,
    explicitProfile: PROFILE
  };
}

export function applyDeepSeekWebRequestTransform(
  payload: JsonObject,
  adapterContext?: AdapterContext
): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  return runReqOutboundStage3CompatWithNative(buildCompatInput(payload, adapterContext)).payload;
}
