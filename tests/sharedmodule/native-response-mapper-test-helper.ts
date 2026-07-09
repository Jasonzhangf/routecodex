import { executeHubPipelineWithNative } from './helpers/hub-pipeline-orchestration-direct-native.js';

export type NativeResponseProtocol = 'openai-chat' | 'anthropic-messages' | 'gemini-chat';

export function mapNativeProviderResponseToChat(
  providerProtocol: NativeResponseProtocol,
  payload: Record<string, unknown>,
  requestSemantics?: Record<string, unknown>
): Record<string, unknown> {
  const output = executeHubPipelineWithNative({
    config: {},
    request: {
      requestId: 'native-response-mapper-test',
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol,
      payload,
      metadata: {
        clientProtocol: 'openai-chat',
        entryEndpoint: '/v1/chat/completions',
        requestSemantics
      },
      stream: false,
      processMode: 'chat',
      direction: 'response',
      stage: 'outbound'
    }
  });
  if (!output.success || !output.payload || typeof output.payload !== 'object' || Array.isArray(output.payload)) {
    const code = output.error?.code ?? 'hub_pipeline_response_mapper_test_failed';
    const message = output.error?.message ?? 'Rust HubPipeline response mapper test failed';
    throw new Error(`${code}: ${message}`);
  }
  return output.payload as Record<string, unknown>;
}

export function createNativeResponseMapper(providerProtocol: NativeResponseProtocol) {
  return {
    toChatCompletion(
      format: { payload?: Record<string, unknown> },
      _ctx: unknown,
      options?: { requestSemantics?: Record<string, unknown> }
    ): Record<string, unknown> {
      return mapNativeProviderResponseToChat(
        providerProtocol,
        (format.payload ?? {}) as Record<string, unknown>,
        options?.requestSemantics
      );
    }
  };
}
