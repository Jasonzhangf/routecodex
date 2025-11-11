export interface ParsedResult<T = any> {
    ok: boolean;
    data?: T;
    errors?: string[];
}
export declare function loadSystemConfig(systemPath: string): Promise<ParsedResult>;
export declare function loadUserConfig(userPath: string): Promise<ParsedResult>;
export declare function writeJsonPretty(filePath: string, data: any): Promise<void>;
