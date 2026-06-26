export interface BuildInfo {
    mode: 'dev' | 'release';
    version: string;
    buildTime: string;
}
export declare const buildInfo: BuildInfo;
