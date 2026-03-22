import type { ConversionContext, ConversionProfile } from '../types.js';
import {
  FilterEngine,
  type FilterContext,
  RequestToolListFilter,
  RequestOpenAIToolsNormalizeFilter,
  RequestToolCallsStringifyFilter,
  RequestToolChoicePolicyFilter,
  ToolPostConstraintsFilter
} from '../../filters/index.js';
import { normalizeChatRequest } from '../index.js';
import { loadFieldMapConfig } from '../../filters/utils/fieldmap-loader.js';
import { createSnapshotWriter } from '../snapshot-utils.js';
import { buildGovernedFilterPayloadWithNative } from '../../router/virtual-router/engine-selection/native-chat-request-filter-semantics.js';

const ALLOW_ARCHIVE_IMPORTS =
  process.env.LLMSWITCH_ALLOW_ARCHIVE_IMPORTS === '1' ||
  process.env.ROUTECODEX_ALLOW_ARCHIVE_IMPORTS === '1';

if (!ALLOW_ARCHIVE_IMPORTS) {
  throw new Error(
    '[archive] shared/archive/chat-request-filters.legacy is fail-closed. Set LLMSWITCH_ALLOW_ARCHIVE_IMPORTS=1 only for explicit migration/parity work.'
  );
}

/**
 * 统一的 Chat 请求侧过滤链路。
 *
 * 目标：
 * - 所有进入 Provider 的 Chat 形状请求（无论入口为 /v1/chat、/v1/responses 还是 /v1/messages），
 *   都在这里走同一套工具治理与参数标准化逻辑。
 */
export async function runStandardChatRequestFilters(
  chatRequest: any,
  profile: ConversionProfile,
  context: ConversionContext
): Promise<any> {
  const existingMetadata = context.metadata ?? {};
  if (!context.metadata) {
    context.metadata = existingMetadata;
  }
  const inboundStreamFromContext =
    typeof existingMetadata.inboundStream === 'boolean' ? (existingMetadata.inboundStream as boolean) : undefined;
  const inboundStreamDetected =
    chatRequest && typeof chatRequest === 'object' && (chatRequest as any).stream === true ? true : undefined;
  const normalizedInboundStream = inboundStreamFromContext ?? inboundStreamDetected;
  if (typeof normalizedInboundStream === 'boolean') {
    existingMetadata.inboundStream = normalizedInboundStream;
  }
  const requestId = context.requestId ?? `req_${Date.now()}`;
  const modelId =
    (chatRequest && typeof chatRequest === 'object' && typeof (chatRequest as any).model === 'string')
      ? String((chatRequest as any).model)
      : 'unknown';

  const endpoint =
    context.entryEndpoint ||
    context.endpoint ||
    '/v1/chat/completions';

  const snapshot = createSnapshotWriter({
    requestId,
    endpoint,
    folderHint: 'openai-chat'
  });
  const snapshotStage = (stage: string, payload: unknown) => {
    if (!snapshot) return;
    snapshot(stage, payload);
  };
  snapshotStage('req_process_filters_input', chatRequest);

  const reqCtxBase: Omit<FilterContext, 'stage'> = {
    requestId,
    model: modelId,
    endpoint,
    profile: profile.outgoingProtocol,
    debug: { emit: () => {} }
  };

  const engine = new FilterEngine();
  const incomingProtocol = (profile.incomingProtocol || '').toLowerCase();
  const entryEndpointLower = endpoint.toLowerCase();
  const originalToolCount =
    (chatRequest && typeof chatRequest === 'object' && Array.isArray((chatRequest as any).tools))
      ? ((chatRequest as any).tools as any[]).length
      : 0;
  const isAnthropicProfile =
    incomingProtocol === 'anthropic-messages' ||
    entryEndpointLower.includes('/v1/messages');
  const skipAutoToolInjection = isAnthropicProfile && originalToolCount === 0;

  // Request-side initial filters（与 openai-openai-codec 保持一致）
  if (!skipAutoToolInjection) {
    engine.registerFilter(new RequestToolListFilter());
  }

  engine.registerFilter(new RequestToolCallsStringifyFilter());
  engine.registerFilter(new RequestToolChoicePolicyFilter());
  // FieldMap：保持与 Chat 入口一致，使用 openai-openai.fieldmap.json
  const cfg = await loadFieldMapConfig('openai-openai.fieldmap.json');
  if (cfg) engine.setFieldMap(cfg);
  engine.registerTransform(
    'stringifyJson',
    (v: unknown) => (typeof v === 'string'
      ? v
      : (() => {
          try { return JSON.stringify(v ?? {}); }
          catch { return '{}'; }
        })())
  );

  let staged = await engine.run('request_pre', chatRequest, reqCtxBase);
  snapshotStage('req_process_filters_request_pre', staged);
  staged = await engine.run('request_map', staged, reqCtxBase);
  snapshotStage('req_process_filters_request_map', staged);
  staged = await engine.run('request_post', staged, reqCtxBase);
  snapshotStage('req_process_filters_request_post', staged);
  if (skipAutoToolInjection && staged && typeof staged === 'object') {
    if (!Array.isArray((staged as any).tools)) {
      (staged as Record<string, unknown>).tools = [];
    }
    (staged as Record<string, unknown>).__rcc_disable_mcp_tools = true;
  }

  // Native-first: use Rust payload semantics as canonical request shape for the filter-finalize stage.
  const nativeGovernedPayload = buildGovernedFilterPayloadWithNative(staged);
  if (skipAutoToolInjection && nativeGovernedPayload && typeof nativeGovernedPayload === 'object') {
    if (!Array.isArray((nativeGovernedPayload as any).tools)) {
      (nativeGovernedPayload as Record<string, unknown>).tools = [];
    }
    (nativeGovernedPayload as Record<string, unknown>).__rcc_disable_mcp_tools = true;
  }
  // 归一化 Chat 请求后再做最终工具治理
  let normalized = normalizeChatRequest(nativeGovernedPayload);
  snapshotStage('req_process_filters_normalized', normalized);

  engine.registerFilter(new RequestOpenAIToolsNormalizeFilter());
  // 工具治理后的最后约束层：默认配置为空，由宿主/配置系统按 profile/provider/modelId 决定是否启用具体规则。
  engine.registerFilter(new ToolPostConstraintsFilter('request_finalize'));
  normalized = await engine.run('request_finalize', normalized as any, reqCtxBase);
  snapshotStage('req_process_filters_request_finalize', normalized);

  const preserveStreamField =
    profile.incomingProtocol === 'openai-chat' && profile.outgoingProtocol === 'openai-chat';

  const pruned = pruneChatRequestPayload(normalized, { preserveStreamField });
  snapshotStage('req_process_filters_output', pruned);
  return pruned;
}

function pruneChatRequestPayload(
  chatRequest: any,
  options?: { preserveStreamField?: boolean }
): any {
  if (!chatRequest || typeof chatRequest !== 'object') return chatRequest;
  const stripped = { ...chatRequest };
  stripSentinelKeys(stripped);
  if ('originalStream' in stripped) {
    delete (stripped as Record<string, unknown>).originalStream;
  }
  if ('_originalStreamOptions' in stripped) {
    delete (stripped as Record<string, unknown>)._originalStreamOptions;
  }
  if ('metadata' in stripped) {
    delete stripped.metadata;
  }
  if (!options?.preserveStreamField && 'stream' in stripped && stripped.stream !== true) {
    delete stripped.stream;
  }
  if (Array.isArray(stripped.messages)) {
    stripped.messages = stripped.messages.map((message: any) => sanitizeMessageEntry(message));
  }
  return stripped;
}

function sanitizeMessageEntry(message: any): any {
  if (!message || typeof message !== 'object') return message;
  const clone = { ...message };
  if (Array.isArray(clone.tool_calls) && clone.tool_calls.length) {
    clone.tool_calls = clone.tool_calls.map((call: any) => sanitizeToolCallEntry(call));
  }
  if (clone.role === 'tool') {
    if (typeof clone.tool_call_id !== 'string' && typeof clone.call_id === 'string') {
      clone.tool_call_id = clone.call_id;
    }
    if ('id' in clone) {
      delete clone.id;
    }
  }
  if ('call_id' in clone) {
    delete clone.call_id;
  }
  return clone;
}

function sanitizeToolCallEntry(call: any): any {
  if (!call || typeof call !== 'object') return call;
  const clone = { ...call };
  delete clone.call_id;
  delete clone.tool_call_id;
  if (clone.function && typeof clone.function === 'object') {
    clone.function = { ...(clone.function as Record<string, unknown>) };
  }
  return clone;
}

function stripSentinelKeys(record: Record<string, unknown>): void {
  Object.keys(record).forEach((key) => {
    if (key.startsWith('__rcc_')) {
      delete record[key];
    }
  });
}
