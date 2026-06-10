// feature_id: config.provider_config_codec
import fs from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../utils/common-utils.js';
import type { ProviderConfigV2 } from './provider-v2-loader.js';
import type { UnknownRecord } from './virtual-router-types.js';
import { parseTomlRecord } from './toml-basic.js';

export type ProviderConfigFormat = 'json' | 'toml';

export interface DecodedProviderConfigFile {
  path: string;
  format: ProviderConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

type ReadFileSyncLike = Pick<typeof import('node:fs'), 'readFileSync'>;

export function detectProviderConfigFormat(configPath: string): ProviderConfigFormat {
  const ext = path.extname(configPath).trim().toLowerCase();
  if (ext === '.toml') {
    return 'toml';
  }
  return 'json';
}

export function parseProviderConfigText(raw: string, format: ProviderConfigFormat): UnknownRecord {
  if (!raw.trim()) {
    return {};
  }
  if (format === 'toml') {
    const parsed = parseTomlRecord(raw);
    return isRecord(parsed) ? (parsed as UnknownRecord) : {};
  }
  const parsed = JSON.parse(raw);
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
  const providerNode = (parsed as { provider?: unknown }).provider;
  if (!isRecord(providerNode)) {
    return null;
  }
  const providerRecord = providerNode as UnknownRecord;
  const providerIdRaw = typeof parsed.providerId === 'string' ? parsed.providerId.trim() : '';
  const providerNodeId = typeof providerRecord.id === 'string' ? providerRecord.id.trim() : '';
  const providerId = providerIdRaw || providerNodeId || String(fallbackProviderId || '').trim();
  if (!providerId) {
    return null;
  }
  if (!providerNodeId) {
    providerRecord.id = providerId;
  }
  const versionRaw = (parsed as { version?: unknown }).version;
  return {
    version: typeof versionRaw === 'string' && versionRaw.trim() ? versionRaw : '2.0.0',
    providerId,
    provider: providerRecord
  };
}
