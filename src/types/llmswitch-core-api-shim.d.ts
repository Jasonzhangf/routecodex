declare module 'rcc-llmswitch-core/api' {
  export const SwitchOrchestrator: any;
  export const processChatRequestTools: any;
  export const processChatResponseTools: any;
  export const captureResponsesContext: any;
  export const buildChatRequestFromResponses: any;
  export const buildResponsesPayloadFromChat: any;
  export const transformOpenAIStreamToResponses: any;
  export const normalizeChatRequest: any;
  export const normalizeTools: any;
  export const chunkString: any;
  export const buildSystemToolGuidance: any;
  export const SchemaValidator: any;
}

declare module '../../../sharedmodule/llmswitch-core/dist/sse/json-to-sse/index.js' {
  export class ChatJsonToSseConverter {
    convertResponseToJsonToSse(payload: unknown, options?: Record<string, unknown>): Promise<import('node:stream').Readable>;
  }

  export class ResponsesJsonToSseConverter {
    convertResponseToJsonToSse(payload: unknown, options?: Record<string, unknown>): Promise<import('node:stream').Readable>;
  }
}
