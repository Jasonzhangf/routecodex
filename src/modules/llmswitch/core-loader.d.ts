export type LlmsImpl = 'ts' | 'engine';
export declare function resolveCorePackageDir(impl: LlmsImpl): string;
export declare function resolveCoreModulePath(subpath: string, impl?: LlmsImpl): string;
export declare function resolveCoreModuleUrl(subpath: string, impl?: LlmsImpl): string;
export declare function importCoreModule<T = unknown>(subpath: string, impl?: LlmsImpl): Promise<T>;
