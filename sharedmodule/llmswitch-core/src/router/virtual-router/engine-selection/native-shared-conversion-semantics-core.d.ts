export declare function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null;
export declare function safeStringify(value: unknown): string | undefined;
export declare function parseJson(raw: string): unknown | null;
export declare function parseRecord(raw: string): Record<string, unknown> | null;
export declare function parseArray(raw: string): Array<unknown> | null;
export declare function parseString(raw: string): string | null;
export declare function parseStringArray(raw: string): string[] | null;
