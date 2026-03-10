import { buildResponsesPayloadFromChatWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import type { ResponsesOutputItem } from '../../sse/types/index.js';

export interface BuildResponsesOutputOptions {
  response: Record<string, unknown>;
  message?: Record<string, unknown>;
}

export interface BuildResponsesOutputResult {
  outputItems: ResponsesOutputItem[];
  outputText?: string;
  status: string;
  requiredAction?: Record<string, unknown>;
  usage?: unknown;
}

export function buildResponsesOutputFromChat(options: BuildResponsesOutputOptions): BuildResponsesOutputResult {
  const built = buildResponsesPayloadFromChatWithNative(
    {
      id: options.response.id,
      created_at: options.response.created_at,
      created: options.response.created,
      model: options.response.model,
      usage: options.response.usage,
      request_id: options.response.request_id,
      tool_outputs: options.response.tool_outputs,
      __responses_reasoning: options.response.__responses_reasoning,
      __responses_output_text_meta: options.response.__responses_output_text_meta,
      choices: [
        {
          message: options.message ?? null
        }
      ]
    },
    {
      requestId:
        typeof options.response.request_id === 'string'
          ? options.response.request_id
          : (typeof options.response.id === 'string' ? options.response.id : undefined)
    }
  ) as Record<string, unknown>;

  return {
    outputItems: Array.isArray(built.output) ? (built.output as ResponsesOutputItem[]) : [],
    outputText: typeof built.output_text === 'string' ? built.output_text : undefined,
    status: typeof built.status === 'string' ? built.status : 'completed',
    requiredAction:
      built.required_action && typeof built.required_action === 'object' && !Array.isArray(built.required_action)
        ? (built.required_action as Record<string, unknown>)
        : undefined,
    usage: built.usage
  };
}
