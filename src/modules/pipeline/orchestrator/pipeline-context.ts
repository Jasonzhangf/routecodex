export interface TargetMetadata {
  providerKey: string;
  providerType?: string;
  providerProtocol?: string;
  runtimeKey?: string;
  routeName?: string;
  defaultModel?: string;
  [key: string]: unknown;
}
