export declare function extractJsonToolCallsFromTextWithNative(text: string, options?: Record<string, unknown>): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractXMLToolCallsFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractSimpleXmlToolsFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractParameterXmlToolsFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractInvokeToolsFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractToolNamespaceXmlBlocksFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractApplyPatchCallsFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractBareExecCommandFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractExecuteBlocksFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractExploredListDirectoryCallsFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function extractQwenToolCallTokensFromTextWithNative(text: string): Array<{
    id?: string;
    name: string;
    args: string;
}> | null;
export declare function mergeToolCallsWithNative(existing: Array<Record<string, unknown>> | undefined, additions: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>>;
export declare function mapReasoningContentToResponsesOutputWithNative(reasoningContent: unknown): Array<{
    type: 'reasoning';
    content: string;
}>;
export declare function validateToolArgumentsWithNative(toolName: string | undefined, args: unknown): {
    repaired: string;
    success: boolean;
    error?: string;
};
export declare function repairToolCallsWithNative(toolCalls: Array<{
    name?: string;
    arguments?: unknown;
}>): Array<{
    name?: string;
    arguments: string;
}>;
