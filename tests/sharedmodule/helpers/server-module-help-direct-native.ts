import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(__filename);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function parseNativeJson<T>(raw: unknown): T {
  return JSON.parse(String(raw)) as T;
}

export function describeServerContractsDirectNative(): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('describeServerContractsJson')());
}

export function describeServerModuleHelpDirectNative(moduleId: string): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(
    nativeFn('describeServerModuleHelpJson')(String(moduleId || ''))
  );
}
