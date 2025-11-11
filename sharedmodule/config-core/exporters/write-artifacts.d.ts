export interface Artifacts {
    systemParsed?: any;
    userParsed?: any;
    canonical?: any;
    assemblerConfig?: any;
    merged?: any;
}
export declare function writeArtifacts(outDir: string, arts: Artifacts): Promise<void>;
