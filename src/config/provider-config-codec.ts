// feature_id: config.provider_config_codec
import fs from 'node:fs/promises';

import { coerceRouteCodexProviderConfigV2Sync } from '../modules/llmswitch/bridge.js';
import { isRecord } from '../utils/common-utils.js';
import type { ProviderConfigV2 } from './provider-v2-loader.js';
import { parseTomlRecord } from './toml-basic.js';

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
  if (!configPath.trim().toLowerCase().endsWith('.toml')) {
    throw new Error(`[config] provider config JSON support removed; expected TOML file: ${configPath}`);
  }
  return 'toml';
}

export function parseProviderConfigText(raw: string, format: ProviderConfigFormat): UnknownRecord {
  if (!raw.trim()) {
    return {};
  }
  const parsed = parseTomlRecord(raw);
  return isRecord(parsed) ? (parsed as UnknownRecord) : {};
}

export async function decodeProviderConfigFile(configPath: string): Promise<DecodedProviderConfigFile> {
  const raw = await fs.readFile(configPath, 'utf8');
  const format = detectProviderConfigFormat(configPath);
  const parsed = parseProviderConfigText(raw, format);
  return {
    path: configPath,
    format,
    raw,
    parsed
  };
}

export function decodeProviderConfigFileSync(
  configPath: string,
  fsImpl: ReadFileSyncLike
): DecodedProviderConfigFile {
  const raw = fsImpl.readFileSync(configPath, 'utf8');
  const format = detectProviderConfigFormat(configPath);
  const parsed = parseProviderConfigText(raw, format);
  return {
    path: configPath,
    format,
    raw,
    parsed
  };
}

export function coerceProviderConfigV2FromParsed(parsed: UnknownRecord, fallbackProviderId?: string): ProviderConfigV2 | null {
  return coerceRouteCodexProviderConfigV2Sync(parsed, fallbackProviderId) as ProviderConfigV2 | null;
}
