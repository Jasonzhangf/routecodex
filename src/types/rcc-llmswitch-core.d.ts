declare module 'rcc-llmswitch-core' { const anyModule: any; export = anyModule; }
declare module 'rcc-llmswitch-core/conversion' {
  export const extractRCCToolCallsFromText: any;
  export const extractApplyPatchCallsFromText: any;
  export const extractExecuteBlocksFromText: any;
  export const buildResponsesPayloadFromChat: any;
  export const normalizeTools: any;
  export const chunkString: any;
}
declare module 'rcc-llmswitch-core/guidance' { const anyModule: any; export = anyModule; }
declare module 'rcc-llmswitch-core/llmswitch/*' { const anyModule: any; export = anyModule; }
declare module 'rcc-llmswitch-core/llmswitch/openai-normalizer' {
  export class OpenAINormalizerLLMSwitch {
    readonly id: string;
    readonly type: string;
    readonly config: any;
    initialize(): Promise<void>;
    processIncoming(request: any): Promise<any>;
    processOutgoing(response: any): Promise<any>;
    transformRequest(request: any): Promise<any>;
    transformResponse(response: any): Promise<any>;
    cleanup(): Promise<void>;
    constructor(config?: any, dependencies?: any);
  }
}
declare module 'rcc-llmswitch-core/llmswitch/anthropic-openai-converter' {
  export class AnthropicOpenAIConverter {
    readonly id: string;
    readonly type: string;
    readonly config: any;
    initialize(): Promise<void>;
    processIncoming(request: any): Promise<any>;
    processOutgoing(response: any): Promise<any>;
    transformRequest(request: any): Promise<any>;
    transformResponse(response: any): Promise<any>;
    cleanup(): Promise<void>;
    constructor(config?: any, dependencies?: any);
  }
}
declare module 'rcc-llmswitch-core/llmswitch/llmswitch-response-chat' {
  export class ResponsesToChatLLMSwitch {
    readonly id: string;
    readonly type: string;
    readonly config: any;
    initialize(): Promise<void>;
    processIncoming(request: any): Promise<any>;
    processOutgoing(response: any): Promise<any>;
    transformRequest(request: any): Promise<any>;
    transformResponse(response: any): Promise<any>;
    cleanup(): Promise<void>;
    constructor(config?: any, dependencies?: any);
  }
}
declare module 'rcc-llmswitch-core/llmswitch/llmswitch-responses-passthrough' {
  export class ResponsesPassthroughLLMSwitch {
    readonly id: string;
    readonly type: string;
    readonly config: any;
    initialize(): Promise<void>;
    processIncoming(request: any): Promise<any>;
    processOutgoing(response: any): Promise<any>;
    transformRequest(request: any): Promise<any>;
    transformResponse(response: any): Promise<any>;
    cleanup(): Promise<void>;
    constructor(config?: any, dependencies?: any);
  }
}
declare module 'rcc-llmswitch-core/llmswitch/llmswitch-conversion-router' {
  export class ConversionRouterLLMSwitch {
    readonly id: string;
    readonly type: string;
    readonly config: any;
    initialize(): Promise<void>;
    processIncoming(request: any): Promise<any>;
    processOutgoing(response: any): Promise<any>;
    transformRequest(request: any): Promise<any>;
    transformResponse(response: any): Promise<any>;
    cleanup(): Promise<void>;
    constructor(config?: any, dependencies?: any);
  }
}
