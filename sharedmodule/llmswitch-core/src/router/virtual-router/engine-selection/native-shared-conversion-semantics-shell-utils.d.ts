export declare function repairFindMetaWithNative(script: string): string;
export declare function splitCommandStringWithNative(input: string): string[];
export declare function packShellArgsWithNative(input: Record<string, unknown>): Record<string, unknown>;
export declare function flattenByCommaWithNative(items: string[]): string[];
export declare function chunkStringWithNative(s: string, minParts?: number, maxParts?: number, targetChunk?: number): string[];
export declare function deriveToolCallKeyWithNative(call: Record<string, unknown> | null | undefined): string | null;
