import path from 'node:path';
import { createRequire } from 'node:module';

type ToolCallLite = { id?: string; name: string; args: string };

const nodeRequire = createRequire(import.meta.url);
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

function parseNativeJson<T>(raw: unknown, capability: string): T {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  return JSON.parse(raw) as T;
}

function extract(capa: string, text: string, options?: Record<string, unknown>): ToolCallLite[] | null {
  return parseNativeJson<ToolCallLite[] | null>(
    nativeFn(capa)(JSON.stringify({ text: String(text ?? ''), ...(options ? { options } : {}) })),
    capa
  );
}

export function extractApplyPatchCallsFromText(text: string): ToolCallLite[] | null {
  return extract('extractApplyPatchCallsFromTextJson', text);
}

export function extractBareExecCommandFromText(text: string): ToolCallLite[] | null {
  return extract('extractBareExecCommandFromTextJson', text);
}

export function extractExploredListDirectoryCallsFromText(text: string): ToolCallLite[] | null {
  return extract('extractExploredListDirectoryCallsFromTextJson', text);
}

export function extractSimpleXmlToolsFromText(text: string): ToolCallLite[] | null {
  return extract('extractSimpleXmlToolsFromTextJson', text);
}

export function extractToolNamespaceXmlBlocksFromText(text: string): ToolCallLite[] | null {
  return extract('extractToolNamespaceXmlBlocksFromTextJson', text);
}

export function normalizeAssistantTextToToolCalls(
  message: Record<string, unknown>
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(
    nativeFn('normalizeAssistantTextToToolCallsJson')(JSON.stringify(message ?? {})),
    'normalizeAssistantTextToToolCallsJson'
  );
}
