/**
 * ProviderForwarder sticky hint — host-side sessionId 提取
 *
 * 硬约束（设计 §3.5 P0-1）：sticky map **只在 Rust forwarder.rs 内部持有**。
 * 本文件仅提供一个轻量 helper：从 host runtime metadata 中提取 sessionId，
 * 用于把 sticky hint 透传到 Rust NAPI 入口。
 *
 * 禁止：持有 sticky state / cache / map（与 WindsurfAccountPool 无关）。
 */

import type { ProviderRuntimeProfile } from '../api/provider-types.js';

const SESSION_ID_KEYS = [
  'sessionId',
  'session_id',
  'routecodexSessionId',
  'routecodexSessionID',
] as const;

export interface ForwarderStickyHint {
  /** 解析得到的 session id；无则 undefined */
  sessionId: string | undefined;
}

/**
 * 从 runtime profile 的 metadata / extensions 中提取 sticky sessionId。
 *
 * 查找路径（按优先级）：
 * 1. runtime.metadata.sessionId / session_id
 * 2. runtime.metadata.routecodexSessionId / routecodexSessionID
 * 3. runtime.extensions.sessionId
 */
export function extractForwarderStickyHint(
  runtime: ProviderRuntimeProfile | null | undefined
): ForwarderStickyHint {
  if (!runtime) {
    return { sessionId: undefined };
  }
  const metadata = (runtime as unknown as { metadata?: Record<string, unknown> }).metadata;
  if (metadata && typeof metadata === 'object') {
    for (const key of SESSION_ID_KEYS) {
      const v = metadata[key];
      if (typeof v === 'string' && v.trim()) {
        return { sessionId: v.trim() };
      }
    }
  }
  const extensions = (runtime as unknown as { extensions?: Record<string, unknown> }).extensions;
  if (extensions && typeof extensions === 'object') {
    for (const key of SESSION_ID_KEYS) {
      const v = extensions[key];
      if (typeof v === 'string' && v.trim()) {
        return { sessionId: v.trim() };
      }
    }
  }
  return { sessionId: undefined };
}
