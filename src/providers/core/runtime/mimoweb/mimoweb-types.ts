/**
 * MiMo Web Provider types
 */

export interface MimoCookieAuth {
  serviceToken: string;
  userId: string;
  phToken: string;
}

export interface MimoUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface MimoChunk {
  type: 'text' | 'usage' | 'dialogId' | 'finish';
  content?: string;
  usage?: MimoUsage;
}

export interface MimoBotConfigModel {
  name: string;
  model: string;
  pageType: string;
  redirectTo?: string;
  isNew?: boolean;
}

export interface MimoBotConfig {
  modelConfigListNg: MimoBotConfigModel[];
}
