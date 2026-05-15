import type { ProviderHandle } from '../types.js';
import {
  resolveRequestExecutorTrafficRuntimeProfile
} from './request-executor-runtime-blocks.js';

const WEB_PROVIDER_TRAFFIC_SOFT_WAIT_TIMEOUT_MS = 1_500;

export function isWebLikeRuntimeForTraffic(args: {
  runtime: ReturnType<typeof resolveRequestExecutorTrafficRuntimeProfile>;
  compatibilityProfile?: string;
}): boolean {
  const { runtime } = args;
  const tokens = [
    args.compatibilityProfile,
    runtime.compatibilityProfile,
    runtime.providerId,
    runtime.providerKey,
    runtime.providerFamily,
    runtime.runtimeKey,
    runtime.endpoint,
    runtime.baseUrl
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());

  if (args.compatibilityProfile === 'chat:deepseek-web' || args.compatibilityProfile === 'chat:qwenchat-web') {
    return true;
  }

  if (runtime.compatibilityProfile === 'chat:deepseek-web' || runtime.compatibilityProfile === 'chat:qwenchat-web') {
    return true;
  }

  return tokens.some((value) =>
    value === 'deepseek-web' || value.startsWith('deepseek-web.')
    || value === 'qwenchat' || value.startsWith('qwenchat.')
    || value === 'mimoweb' || value.startsWith('mimoweb.')
  );
}

export function resolveProviderTrafficSoftWaitTimeoutMs(args: {
  runtimeKey: string;
  handle: ProviderHandle;
  providerKey?: string;
  compatibilityProfile?: string;
}): number | undefined {
  const runtime = resolveRequestExecutorTrafficRuntimeProfile(args.runtimeKey, args.handle, args.providerKey);
  if (!isWebLikeRuntimeForTraffic({ runtime, compatibilityProfile: args.compatibilityProfile })) {
    return undefined;
  }
  return WEB_PROVIDER_TRAFFIC_SOFT_WAIT_TIMEOUT_MS;
}
