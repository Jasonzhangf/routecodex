// feature_id: config.provider_config_codec
import fs from 'node:fs/promises';

import {
  coerceRouteCodexProviderConfigV2Sync,
  decodeRouteCodexProviderConfigTextSync,
  detectRouteCodexProviderConfigFormatSync,
} from '../modules/llmswitch/bridge.js';
import type { ProviderConfigV2 } from './provider-v2-loader.js';

export type ProviderConfigFormat = 'toml';
type UnknownRecord = Record<string, unknown>;

export interface DecodedProviderConfigFile {
  path: string;
  format: ProviderConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

type ReadFileSyncLike = Pick<typeof import('node:fs'), 'readFileSync'>;

export function detectProviderConfigFormat(configPath: string): ProviderConfigFormat {
  return detectRouteCodexProviderConfigFormatSync(configPath);
}

export function parseProviderConfigText(raw: string, format: ProviderConfigFormat): UnknownRecord {
  if (format === 'toml') {
    return decodeRouteCodexProviderConfigTextSync({ raw }).parsed;
  }
  throw new Error('[config] provider config JSON support removed; parser only accepts TOML');
}

export async function decodeProviderConfigFile(configPath: string): Promise<DecodedProviderConfigFile> {
  detectProviderConfigFormat(configPath);
  const raw = await fs.readFile(configPath, 'utf8');
  const decoded = decodeRouteCodexProviderConfigTextSync({ raw, configPath });
  return {
    path: configPath,
    format: decoded.format,
    raw,
    parsed: decoded.parsed,
  };
}

export function decodeProviderConfigFileSync(
  configPath: string,
  fsImpl: ReadFileSyncLike
): DecodedProviderConfigFile {
  detectProviderConfigFormat(configPath);
  const raw = fsImpl.readFileSync(configPath, 'utf8');
  const decoded = decodeRouteCodexProviderConfigTextSync({ raw, configPath });
  return {
    path: configPath,
    format: decoded.format,
    raw,
    parsed: decoded.parsed,
  };
}

export function coerceProviderConfigV2FromParsed(parsed: UnknownRecord, fallbackProviderId?: string): ProviderConfigV2 | null {
  return coerceRouteCodexProviderConfigV2Sync(parsed, fallbackProviderId) as ProviderConfigV2 | null;
}
