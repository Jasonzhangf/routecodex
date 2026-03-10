import type { Filter, FilterContext, JsonObject, FilterResult } from '../types.js';
import { buildResponsesPayloadFromChat } from '../../conversion/responses/responses-openai-bridge.js';

/**
 * ResponseOpenAIToResponsesBridgeFilter
 * - 将 OpenAI Chat 形状的响应桥接为 OpenAI Responses 形状
 * - 与 Anthropic 并行：使用 filter 进行形状/协议转换（而非 endpoint 分支）
 * - 阶段：response_post（在基础规范化之后执行）
 */
export class ResponseOpenAIToResponsesBridgeFilter implements Filter<JsonObject> {
  readonly name = 'response_openai_to_responses_bridge';
  readonly stage: FilterContext['stage'] = 'response_post';

  async apply(input: JsonObject, ctx: FilterContext): Promise<FilterResult<JsonObject>> {
    try {
      const requestId = ctx.requestId || `resp_${Date.now()}`;
      const context = { requestId, endpoint: '/v1/responses', metadata: {} } as any;
      const bridged = buildResponsesPayloadFromChat(input as any, context);
      return { ok: true, data: bridged as unknown as JsonObject };
    } catch {
      // 桥接失败则保持原样（Fail Fast 由上层处理）
      return { ok: true, data: input };
    }
  }
}

export default ResponseOpenAIToResponsesBridgeFilter;
