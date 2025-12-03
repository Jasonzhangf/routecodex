export interface TargetMetadata {
  providerKey: string;
  providerType?: string;
  providerProtocol?: string;
  runtimeKey?: string;
  routeName?: string;
  defaultModel?: string;
  compatibilityProfile?: string;
  [key: string]: unknown;
}
