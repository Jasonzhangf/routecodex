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
  export const refineSystemToolGuidance: any;
  export const SchemaValidator: any;
}

