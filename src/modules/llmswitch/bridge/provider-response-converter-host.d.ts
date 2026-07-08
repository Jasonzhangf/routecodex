import type { Readable } from 'node:stream';
type AdapterContext = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type StageRecorder = {
    record(stage: string, payload: object): void;
};
type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
export declare function convertProviderResponse(options: {
    providerProtocol: ProviderProtocol;
    providerResponse: JsonObject;
    context: AdapterContext;
    entryEndpoint: string;
    wantsStream: boolean;
    stageRecorder?: StageRecorder;
}): Promise<{
    body?: JsonObject;
    sseStream?: Readable;
    format?: string;
}>;
export {};
