export interface BaseProviderConfig {
  type: string;
  baseUrl?: string;
  auth?: Record<string, unknown>;
}

export interface BaseTransformationRule {
  id: string;
  transform: string;
  sourcePath?: string;
  targetPath?: string;
  mapping?: Record<string, unknown>;
  condition?: Record<string, unknown>;
}

