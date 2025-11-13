export type AuthConfig = {
  type: 'apikey' | 'oauth';
  apiKey?: string;
  headerName?: string;
  prefix?: string;
};

export type ProviderInputConfig = {
  providerId: string;
  type: string; // e.g., 'openai' | 'openai-standard' | 'glm' | 'qwen' | 'modelscope' | 'anthropic' | 'iflow'
  baseUrl?: string;
  baseURL?: string;
  auth?: AuthConfig;
  apiKey?: string[]; // optional key list; auth.apiKey uses first by default
};

export type UpdateOptions = {
  providerId?: string;
  configPath: string;
  write: boolean;
  outputDir?: string;
  blacklistAdd?: string[];
  blacklistRemove?: string[];
  blacklistFile?: string;
  listOnly?: boolean;
  useCache?: boolean;
  probeKeys?: boolean;
  verbose?: boolean;
};

export type ModelsList = {
  models: string[];
  raw?: unknown;
};

export type BlacklistFile = {
  models: string[];
  updatedAt: number;
};

export type ProviderSingleConfig = Record<string, unknown>;

export type UpdateResult = {
  providerId: string;
  totalRemote: number;
  filtered: number;
  added: string[];
  removed: string[];
  kept: string[];
  completedWithTemplates: string[];
  outputPath: string;
  blacklistPath: string;
};
