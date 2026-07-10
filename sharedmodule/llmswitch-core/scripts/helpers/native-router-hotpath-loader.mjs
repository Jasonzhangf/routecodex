import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const nativeBinding = nodeRequire(path.resolve(repoRoot, 'dist/native/router_hotpath_napi.node'));

export const VIRTUAL_ROUTER_ERROR_PREFIX = 'VIRTUAL_ROUTER_ERROR:';

export class VirtualRouterError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'VirtualRouterError';
    this.code = code;
    this.details = details;
  }
}

export function readNativeFunction(name) {
  const fn = nativeBinding?.[name] ?? nativeBinding?.[name.replace(/_([a-z])/g, (_match, char) => char.toUpperCase())];
  return typeof fn === 'function' ? fn : null;
}

export function loadNativeRouterHotpathBinding() {
  return nativeBinding;
}

export function loadNativeRouterHotpathBindingForInternalUse() {
  return nativeBinding;
}

export function parseVirtualRouterNativeError(error) {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? '');
  const normalized = message.startsWith('Error:') ? message.replace(/^Error:\s*/, '') : message;
  if (!normalized.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) return null;
  const remainder = normalized.slice(VIRTUAL_ROUTER_ERROR_PREFIX.length);
  const index = remainder.indexOf(':');
  if (index <= 0) return null;
  const code = remainder.slice(0, index);
  const rawPayload = remainder.slice(index + 1).trim();
  if (!rawPayload.startsWith('{')) {
    return new VirtualRouterError(rawPayload || 'Virtual router error', code);
  }
  try {
    const parsed = JSON.parse(rawPayload);
    return new VirtualRouterError(
      typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : rawPayload,
      code,
      parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details) ? parsed.details : undefined
    );
  } catch {
    return new VirtualRouterError(rawPayload || 'Virtual router error', code);
  }
}
