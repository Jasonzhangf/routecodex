export declare function resolveCorePackageDir(): string;
export declare function resolveCoreModulePath(subpath: string): string;
export declare function resolveCoreModuleUrl(subpath: string): string;
export declare function importCoreModule<T = unknown>(subpath: string): Promise<T>;
