import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

type NativeFailurePolicyBridge = {
  classifyProviderFailure?: (
    statusCode: number | undefined,
    errorCode: string | undefined,
    upstreamCode: string | undefined,
    isNetworkError: boolean
  ) => string;
};

const nativeRequire = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let cachedNativeFailurePolicy: NativeFailurePolicyBridge | null | undefined;

export function loadNativeFailurePolicyBridge(): NativeFailurePolicyBridge | null {
  if (cachedNativeFailurePolicy !== undefined) {
    return cachedNativeFailurePolicy;
  }
  try {
    const mod = nativeRequire('rcc-llmswitch-core');
    if (mod && typeof mod.classifyProviderFailureJson === 'function') {
      cachedNativeFailurePolicy = { classifyProviderFailure: mod.classifyProviderFailureJson };
      return cachedNativeFailurePolicy;
    }
    const nativePath = path.resolve(
      moduleDir,
      '../../../../sharedmodule/llmswitch-core/dist/router/virtual-router/engine-selection/native-failure-policy.js'
    );
    cachedNativeFailurePolicy = nativeRequire(nativePath) as NativeFailurePolicyBridge;
    return cachedNativeFailurePolicy;
  } catch {
    cachedNativeFailurePolicy = null;
    return cachedNativeFailurePolicy;
  }
}
