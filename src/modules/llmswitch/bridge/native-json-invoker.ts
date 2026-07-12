/**
 * Shared host-side native JSON invocation helpers.
 *
 * This module owns only binding lookup, JSON argument encoding, native call
 * execution, JSON result parsing, and fail-fast shape assertions.
 */

export type NativeJsonBinding = Record<string, unknown>;
export type NativeBindingProvider = () => NativeJsonBinding;

type NativeInvokerOptions = {
  label?: string;
};

type StringifyOptions = NativeInvokerOptions & {
  nullOnStringifyFailure?: boolean;
};

function labelPrefix(options?: NativeInvokerOptions): string {
  return options?.label ?? 'llmswitch-bridge';
}

export function requireNativeFunction(
  getBinding: NativeBindingProvider,
  capability: string,
  options?: NativeInvokerOptions,
): (...args: unknown[]) => unknown {
  const fn = getBinding()[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[${labelPrefix(options)}] ${capability} not available`);
  }
  return fn as (...args: unknown[]) => unknown;
}

export function stringifyNativeJsonArg(
  capability: string,
  value: unknown,
  options?: StringifyOptions,
): string | null {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error) {
    if (options?.nullOnStringifyFailure) {
      return null;
    }
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[${labelPrefix(options)}] ${capability} JSON stringify failed: ${detail}`);
  }
}

export function parseNativeJsonResult<T = unknown>(
  capability: string,
  raw: unknown,
  options?: NativeInvokerOptions,
): T {
  if (raw instanceof Error) {
    throw new Error(`[${labelPrefix(options)}] ${capability} native error: ${raw.message || 'unknown error'}`);
  }
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    typeof (raw as { message?: unknown }).message === 'string'
  ) {
    throw new Error(`[${labelPrefix(options)}] ${capability} native error: ${String((raw as { message: unknown }).message)}`);
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[${labelPrefix(options)}] ${capability} returned non-string or empty result`);
  }
  if (raw.startsWith('Error:')) {
    throw new Error(raw.slice('Error:'.length).trimStart());
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[${labelPrefix(options)}] ${capability} JSON parse failed: ${detail}`);
  }
}

export function callNativeJsonCapability<T = unknown>(
  getBinding: NativeBindingProvider,
  capability: string,
  args: unknown[],
  options?: NativeInvokerOptions,
): T {
  const fn = requireNativeFunction(getBinding, capability, options);
  const encodedArgs = args.map((arg) => {
    const encoded = stringifyNativeJsonArg(capability, arg, options);
    if (encoded === null) {
      throw new Error(`[${labelPrefix(options)}] ${capability} JSON stringify returned null`);
    }
    return encoded;
  });
  return parseNativeJsonResult<T>(capability, fn(...encodedArgs), options);
}

export function callNativePreencodedJsonCapability<T = unknown>(
  getBinding: NativeBindingProvider,
  capability: string,
  args: unknown[],
  options?: NativeInvokerOptions,
): T {
  const fn = requireNativeFunction(getBinding, capability, options);
  return parseNativeJsonResult<T>(capability, fn(...args), options);
}

export function assertNativeObject<T extends Record<string, unknown> = Record<string, unknown>>(
  capability: string,
  value: unknown,
  options?: NativeInvokerOptions,
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[${labelPrefix(options)}] ${capability} returned invalid payload`);
  }
  return value as T;
}

export function assertNativeArray(
  capability: string,
  value: unknown,
  options?: NativeInvokerOptions,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[${labelPrefix(options)}] ${capability} returned invalid payload`);
  }
  return value;
}

export function parseNativeOptionalObjectResult<T extends Record<string, unknown> = Record<string, unknown>>(
  capability: string,
  raw: unknown,
  options?: NativeInvokerOptions,
): T | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  return assertNativeObject<T>(capability, parseNativeJsonResult(capability, raw, options), options);
}

export function parseNativeBooleanResult(
  capability: string,
  raw: unknown,
  options?: NativeInvokerOptions,
): boolean {
  const parsed = assertNativeObject(capability, parseNativeJsonResult(capability, raw, options), options);
  if (typeof parsed.result !== 'boolean') {
    throw new Error(`[${labelPrefix(options)}] ${capability} returned malformed boolean result`);
  }
  return parsed.result;
}
