export function isNativeDisabledByEnv(): boolean {
  return false;
}

export function isNativeRequiredByEnv(): boolean {
  return true;
}

export function hasCompleteNativeBinding(binding: unknown, requiredExports: readonly string[]): boolean {
  if (!binding || typeof binding !== 'object') return false;
  const row = binding as Record<string, unknown>;
  return requiredExports.every((key) => typeof row[key] === 'function');
}

export function makeNativeRequiredError(capability: string, reason?: string): Error {
  return new Error(
    `[virtual-router-native-hotpath] native ${capability} is required but unavailable${reason ? `: ${reason}` : ''}`
  );
}

export function failNativeRequired<T>(capability: string, reason?: string): T {
  throw makeNativeRequiredError(capability, reason);
}
