export declare function writeErrorsampleJson(options: {
    group: string;
    kind: string;
    payload: unknown;
    scopeId?: string;
    entryPort?: number;
    serverId?: string;
}): Promise<string | null>;
export declare function __flushErrorsampleQueueForTests(): Promise<void>;
export declare function __resetErrorsampleQueueForTests(): void;
