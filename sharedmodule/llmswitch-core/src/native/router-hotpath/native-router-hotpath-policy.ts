export enum VirtualRouterErrorCode {
  NO_STANDARDIZED_REQUEST = "NO_STANDARDIZED_REQUEST",
  ROUTE_NOT_FOUND = "ROUTE_NOT_FOUND",
  PROVIDER_NOT_AVAILABLE = "PROVIDER_NOT_AVAILABLE",
  HTTP_429 = "HTTP_429",
  CONFIG_ERROR = "CONFIG_ERROR",
}

export class VirtualRouterError extends Error {
  constructor(
    message: string,
    public readonly code: VirtualRouterErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VirtualRouterError";
  }
}

export function isNativeDisabledByEnv(): boolean {
  return false;
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
