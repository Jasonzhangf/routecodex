import fs from 'node:fs';
import path from 'node:path';

export type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

export type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

export type UnknownRecord = Record<string, unknown>;

export type RoutingConfig = Record<string, unknown>;

export type ProviderV2Payload = {
  version: string;
  providerId: string;
  provider: UnknownRecord;
};

export type DuplicateProviderResolution = 'keep' | 'overwrite' | 'merge';
export type DuplicateMigrationStrategy = 'overwrite_all' | 'per_provider' | 'keep_all';

export type PromptLike = (question: string) => Promise<string>;

export type ConfigState =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'v1'; data: UnknownRecord }
  | { kind: 'v2'; data: UnknownRecord };

export type CustomProtocolPreset = {
  id: '1' | '2' | '3' | '4';
  key: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  label: string;
  providerType: string;
};

export const CUSTOM_PROTOCOL_PRESETS: CustomProtocolPreset[] = [
  { id: '1', key: 'openai-chat', label: 'OpenAI Chat', providerType: 'openai' },
  { id: '2', key: 'openai-responses', label: 'OpenAI Responses', providerType: 'responses' },
  { id: '3', key: 'anthropic', label: 'Anthropic Messages', providerType: 'anthropic' },
  { id: '4', key: 'gemini', label: 'Gemini Chat', providerType: 'gemini' }
];

export type InitCommandContext = {
  logger: LoggerLike;
  createSpinner: (text: string) => Promise<Spinner>;
  getHomeDir?: () => string;
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  prompt?: (question: string) => Promise<string>;
  prepareCamoufoxEnvironment?: () => boolean;
};

export type InitCommandOptions = {
  config?: string;
  force?: boolean;
  camoufox?: boolean;
  providers?: string;
  defaultProvider?: string;
  host?: string;
  port?: string;
  listProviders?: boolean;
  listCurrentProviders?: boolean;
};
