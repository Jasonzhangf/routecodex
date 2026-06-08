import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { buildServertoolReq04FollowupPayloadWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export function buildStopMessageLoopPayload(adapterContext: AdapterContext): JsonObject | null {
  const payload = buildServertoolReq04FollowupPayloadWithNative(adapterContext);
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }
  return payload as JsonObject;
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
