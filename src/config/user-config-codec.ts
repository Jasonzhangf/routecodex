// feature_id: config.user_config_codec
import fs from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../utils/common-utils.js';
import { parseTomlRecord } from './toml-basic.js';

export type UserConfigFormat = 'json' | 'toml';
export type UnknownRecord = Record<string, unknown>;

export interface DecodedUserConfigFile {
  path: string;
  format: UserConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

type ReadFileSyncLike = Pick<typeof import('node:fs'), 'readFileSync'>;

export function detectUserConfigFormat(configPath: string): UserConfigFormat {
  const ext = path.extname(configPath).trim().toLowerCase();
  if (ext === '.toml') {
    return 'toml';
  }
  return 'json';
}

export function parseUserConfigText(raw: string, format: UserConfigFormat): UnknownRecord {
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

export async function decodeUserConfigFile(configPath: string): Promise<DecodedUserConfigFile> {
  const raw = await fs.readFile(configPath, 'utf8');
  const format = detectUserConfigFormat(configPath);
  const parsed = parseUserConfigText(raw, format);
  return {
    path: configPath,
    format,
    raw,
    parsed
  };
}

export function decodeUserConfigFileSync(
  configPath: string,
  fsImpl: ReadFileSyncLike
): DecodedUserConfigFile {
  const raw = fsImpl.readFileSync(configPath, 'utf8');
  const format = detectUserConfigFormat(configPath);
  const parsed = parseUserConfigText(raw, format);
  return {
    path: configPath,
    format,
    raw,
    parsed
  };
}
