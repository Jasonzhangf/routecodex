/**
 * Native-only tool call validation shell.
 *
 * Rust owns shape validation, broad-kill detection, and shell wrapper checks.
 * If the native binding is absent or fails, this layer must fail fast instead
 * of running a second TypeScript validator.
 */

import { getRouterHotpathJsonBindingSync } from '../../../../modules/llmswitch/bridge/native-exports.js';

type ValidationResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  missingFields?: string[];
  normalizedArgs?: string;
};

type NativeToolValidationBinding = NonNullable<ReturnType<typeof getRouterHotpathJsonBindingSync>>;

function loadNativeToolValidationBinding(): NativeToolValidationBinding {
  const binding = getRouterHotpathJsonBindingSync();
  return binding;
}

function requireNativeFunction<K extends keyof NativeToolValidationBinding>(
  binding: NativeToolValidationBinding,
  name: K
): NonNullable<NativeToolValidationBinding[K]> {
  const fn = binding[name];
  if (typeof fn !== 'function') {
    throw new Error(`provider_response_tool_validation_native_unavailable: ${String(name)}`);
  }
  return fn as NonNullable<NativeToolValidationBinding[K]>;
}

function parseNativeJson<T>(raw: string, functionName: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`provider_response_tool_validation_native_invalid_json: ${functionName}: ${message}`);
  }
}

function callNativeJson<T>(
  functionName: keyof NativeToolValidationBinding,
  input: Record<string, unknown>
): T {
  const binding = loadNativeToolValidationBinding();
  const fn = requireNativeFunction(binding, functionName) as (inputJson: string) => string;
  try {
    return parseNativeJson<T>(fn(JSON.stringify(input)), String(functionName));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('provider_response_tool_validation_native_')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`provider_response_tool_validation_native_failed: ${String(functionName)}: ${message}`);
  }
}

export function containsBroadKillCommand(cmd: string): boolean {
  const parsed = callNativeJson<{ result: boolean }>('containsBroadKillCommandJson', { cmd });
  return parsed.result === true;
}

export function hasInvalidShellWrapperShape(cmd: string): boolean {
  const parsed = callNativeJson<{ result: boolean }>('hasInvalidShellWrapperShapeJson', { cmd });
  return parsed.result === true;
}

export function validateCanonicalClientToolCall(
  name: string,
  argsString: string,
  _declaredToolNames?: Set<string>
): ValidationResult {
  return callNativeJson<ValidationResult>('validateCanonicalClientToolCallJson', { name, argsString });
}
