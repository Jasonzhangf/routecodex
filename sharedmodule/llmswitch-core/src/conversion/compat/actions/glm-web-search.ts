import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildGlmRequestCompatInput } from './glm-native-compat.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DEBUG_GLM_WEB_SEARCH = (process.env.ROUTECODEX_DEBUG_GLM_WEB_SEARCH || '').trim() === '1';

export function applyGlmWebSearchRequestTransform(payload: JsonObject): JsonObject {
  const root = structuredClone(payload) as UnknownRecord;
  const webSearchRaw = (root as { web_search?: unknown }).web_search;
  if (!isRecord(webSearchRaw)) {
    return root as JsonObject;
  }
  const query = typeof webSearchRaw.query === 'string' ? webSearchRaw.query.trim() : '';
  const recency = typeof webSearchRaw.recency === 'string' ? webSearchRaw.recency.trim() : undefined;
  const count = typeof webSearchRaw.count === 'number' && Number.isFinite(webSearchRaw.count)
    ? Math.floor(webSearchRaw.count)
    : undefined;
  const normalized = runReqOutboundStage3CompatWithNative(buildGlmRequestCompatInput(payload)).payload;

  if (DEBUG_GLM_WEB_SEARCH) {
    try {
      // eslint-disable-next-line no-console
      console.log(
        '\x1b[38;5;27m[compat][glm_web_search_request] applied web_search transform ' +
          `search_engine=search_std ` +
          `query=${JSON.stringify(query).slice(0, 200)} ` +
          `count=${String(count ?? '')}\x1b[0m`
      );
    } catch {
      // logging best-effort
    }
  }

  return normalized;
}
