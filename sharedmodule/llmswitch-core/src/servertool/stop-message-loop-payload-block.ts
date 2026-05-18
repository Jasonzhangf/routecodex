import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { extractCapturedChatSeed } from './followup-seed.js';

function resolveCapturedChatRequest(adapterContext: AdapterContext): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const record = adapterContext as Record<string, unknown>;
  const direct = record.capturedChatRequest;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as JsonObject;
  }
  return null;
}

export function buildStopMessageLoopPayload(adapterContext: AdapterContext): JsonObject | null {
  const captured = resolveCapturedChatRequest(adapterContext);
  const seed = extractCapturedChatSeed(captured);
  if (!seed || !Array.isArray(seed.messages) || seed.messages.length === 0) {
    return null;
  }
  const payload: JsonObject = {
    messages: seed.messages
  };
  if (seed.model) {
    payload.model = seed.model;
  }
  if (Array.isArray(seed.tools) && seed.tools.length > 0) {
    payload.tools = seed.tools;
  }
  if (seed.parameters && typeof seed.parameters === 'object' && !Array.isArray(seed.parameters)) {
    payload.parameters = seed.parameters as JsonObject;
  }
  return payload;
}

export function appendStopMessageLoopWarning(args: {
  payload: JsonObject;
  repeatCountRaw: number;
  warnThreshold: number;
  failThreshold: number;
}): void {
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    return;
  }
  const messages = Array.isArray((args.payload as { messages?: unknown }).messages)
    ? ((args.payload as { messages: unknown[] }).messages as unknown[])
    : null;
  if (!messages) {
    return;
  }
  const repeatCount = Number.isFinite(args.repeatCountRaw)
    ? Math.max(args.warnThreshold, Math.floor(args.repeatCountRaw))
    : args.warnThreshold;
  const warningText = [
    `检测到 stopMessage 请求/响应参数已连续 ${repeatCount} 轮一致。`,
    '请立即尝试跳出循环（换路径、换验证方法、或直接给结论）。',
    `若继续达到 ${args.failThreshold} 轮一致，将返回 fetch failed 网络错误并停止自动续跑。`
  ].join('\n');
  messages.push({
    role: 'system',
    content: warningText
  });
}
