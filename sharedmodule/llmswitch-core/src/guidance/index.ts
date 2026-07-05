// Tool guidance augmentation utilities (OpenAI + Anthropic shapes)
// Standalone module to keep guidance policy centralized and easy to evolve.
import {
  failNativeRequired,
  isNativeDisabledByEnv
} from '../native/router-hotpath/native-router-hotpath-policy.js';
import {
  parseJson,
  parseString,
  readNativeFunction,
  safeStringify
} from '../native/router-hotpath/native-shared-conversion-semantics-core.js';

// For OpenAI tool shape: { type:'function', function:{ name, description?, parameters } }
export function augmentOpenAITools(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return tools;
  return augmentToolsWithNative('augmentOpenAIToolsJson', tools);
}

// For Anthropic tool shape: { name, description?, input_schema }
export function augmentAnthropicTools(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return tools;
  return augmentToolsWithNative('augmentAnthropicToolsJson', tools);
}

function augmentToolsWithNative(capability: string, tools: unknown[]): unknown[] {
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payload = safeStringify(tools);
  if (!payload) {
    return fail('invalid input');
  }
  try {
    const raw = fn(payload);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

// Build a minimal, consistent system tool guidance string (OpenAI tool_calls model)
export function buildSystemToolGuidance(): string {
  const capability = 'buildSystemToolGuidanceJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn();
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseString(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

// 注意：我们不再提供"精炼/替换"已有 system 提示词的能力。
