import { readNativeFunction, parseVirtualRouterNativeError, VirtualRouterError } from './native-router-hotpath-loader.mjs';

export function bootstrapVirtualRouterConfig(input) {
  const fn = readNativeFunction('bootstrapVirtualRouterConfigJson');
  if (typeof fn !== 'function') {
    throw new Error('bootstrapVirtualRouterConfigJson native export is required');
  }
  let raw;
  try {
    raw = fn(JSON.stringify(input ?? {}));
  } catch (error) {
    const parsed = parseVirtualRouterNativeError(error);
    throw parsed ?? error;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned empty payload',
      'CONFIG_ERROR'
    );
  }
  const nativeError = parseVirtualRouterNativeError(raw);
  if (nativeError) {
    throw nativeError;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new VirtualRouterError(
      'Virtual router native config bootstrap returned invalid payload',
      'CONFIG_ERROR'
    );
  }
}
