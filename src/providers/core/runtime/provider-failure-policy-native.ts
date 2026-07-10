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

function buildNativeFailurePolicyBridge(mod: unknown): NativeFailurePolicyBridge | null {
  const fn = (mod as { classifyProviderFailureJson?: unknown } | null)?.classifyProviderFailureJson;
  if (typeof fn !== 'function') {
    return null;
  }
  return {
    classifyProviderFailure: (
      statusCode: number | undefined,
      errorCode: string | undefined,
      upstreamCode: string | undefined,
      isNetworkError: boolean
    ) => {
      const raw = (fn as (...args: unknown[]) => unknown)(
        statusCode,
        errorCode,
        upstreamCode,
        isNetworkError
      );
      const parsed = JSON.parse(String(raw)) as unknown;
      if (parsed !== 'unrecoverable' && parsed !== 'recoverable') {
        throw new Error('native classifyProviderFailureJson returned invalid classification');
      }
      return parsed;
    }
  };
}

function resolveCoreNativeBindingPath(): string {
  return path.resolve(
    resolveModuleDir(),
    '../../../../sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'
  );
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
    const nativePath = resolveCoreNativeBindingPath();
    cachedNativeFailurePolicy = buildNativeFailurePolicyBridge(nativeRequire(nativePath));
    return cachedNativeFailurePolicy;
  } catch {
    cachedNativeFailurePolicy = null;
    return cachedNativeFailurePolicy;
  }
}
