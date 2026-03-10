import type { JsonObject } from '../../hub/types/json.js';
import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildIflowRequestCompatInput } from './iflow-native-compat.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DEBUG_IFLOW_WEB_SEARCH =
  (process.env.ROUTECODEX_DEBUG_IFLOW_WEB_SEARCH || '').trim() === '1';

/**
 * IFlow web_search 请求适配（作用于 openai-chat 兼容 payload）：
 *
 * - 仅在 routeId 以 `web_search` 或 `search` 开头时生效（来自 AdapterContext.routeId）；
 * - 读取顶层的 `web_search` helper 对象 `{ query, recency, count, engine }`；
 * - 当 query 为空或无效时：删除 helper，原样透传；
 * - 当 query 有效时：构造一个标准的 OpenAI function tool：
 *   - name 固定为 `web_search`；
 *   - parameters 包含 query/recency/count 三个字段；
 * - 将生成的 function tool 写入 `tools` 数组，并删除顶层 `web_search`。
 *
 * 注意：
 * - 顶层 `web_search` 只在 servertool 的二跳请求中出现，用于驱动后端搜索；
 * - 用户侧的工具调用仍然使用统一的 `web_search` function tool schema。
 */
export function applyIflowWebSearchRequestTransform(
  payload: JsonObject,
  adapterContext?: AdapterContext
): JsonObject {
  const routeId = typeof adapterContext?.routeId === 'string' ? adapterContext.routeId : '';
  const normalizedRoute = routeId.trim().toLowerCase();
  if (!normalizedRoute || (!normalizedRoute.startsWith('web_search') && !normalizedRoute.startsWith('search'))) {
    return payload;
  }

  const normalized = runReqOutboundStage3CompatWithNative(
    buildIflowRequestCompatInput(payload, adapterContext)
  ).payload;
  const query =
    isRecord(payload) && isRecord((payload as { web_search?: unknown }).web_search)
      ? typeof ((payload as { web_search?: UnknownRecord }).web_search?.query) === 'string'
        ? String((payload as { web_search?: UnknownRecord }).web_search?.query).trim()
        : ''
      : '';
  const recency =
    isRecord(payload) && isRecord((payload as { web_search?: unknown }).web_search)
      ? typeof ((payload as { web_search?: UnknownRecord }).web_search?.recency) === 'string'
        ? String((payload as { web_search?: UnknownRecord }).web_search?.recency).trim()
        : undefined
      : undefined;

  if (DEBUG_IFLOW_WEB_SEARCH) {
    try {
      // eslint-disable-next-line no-console
      console.log(
        '\x1b[38;5;27m[compat][iflow_web_search_request] applied web_search transform ' +
          `query=${JSON.stringify(query).slice(0, 200)} ` +
          `recency=${String(recency ?? '')}\x1b[0m`
      );
    } catch {
      // logging best-effort
    }
  }

  return normalized;
}
