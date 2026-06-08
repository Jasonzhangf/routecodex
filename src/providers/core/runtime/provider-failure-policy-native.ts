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

let cachedNativeFailurePolicy: NativeFailurePolicyBridge | null | undefined;
let _nativeRequire: NodeRequire | undefined;
let _moduleDir: string | undefined;

function resolveNativeRequire(): NodeRequire {
  if (!_nativeRequire) {
    // eval is used here to avoid direct import.meta syntax that causes Jest parse errors.
    // In Jest, JEST_WORKER_ID guard below returns null before this is ever called.
    const metaUrl = eval('import.meta.url') as string | undefined;
    _nativeRequire = metaUrl ? createRequire(metaUrl) : (require as unknown as NodeRequire);
  }
  return _nativeRequire;
}

function resolveModuleDir(): string {
  if (!_moduleDir) {
    const metaUrl = eval('import.meta.url') as string | undefined;
    _moduleDir = metaUrl ? path.dirname(fileURLToPath(metaUrl)) : process.cwd();
  }
  return _moduleDir;
}

export function loadNativeFailurePolicyBridge(): NativeFailurePolicyBridge | null {
  if (process.env.JEST_WORKER_ID !== undefined) {
    return null;
  }
  if (cachedNativeFailurePolicy !== undefined) {
    return cachedNativeFailurePolicy;
  }
  try {
    const nativeRequire = resolveNativeRequire();
    const mod = nativeRequire('rcc-llmswitch-core');
    if (mod && typeof mod.classifyProviderFailureJson === 'function') {
      cachedNativeFailurePolicy = { classifyProviderFailure: mod.classifyProviderFailureJson };
      return cachedNativeFailurePolicy;
    }
    const nativePath = path.resolve(
      resolveModuleDir(),
      '../../../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-failure-policy.js'
    );
    cachedNativeFailurePolicy = nativeRequire(nativePath) as NativeFailurePolicyBridge;
    return cachedNativeFailurePolicy;
  } catch {
    cachedNativeFailurePolicy = null;
    return cachedNativeFailurePolicy;
  }
}
