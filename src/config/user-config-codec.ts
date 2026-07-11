// feature_id: config.user_config_codec
import fs from 'node:fs/promises';

import {
  decodeRouteCodexUserConfigTextSync,
  detectRouteCodexUserConfigFormatSync,
} from '../modules/llmswitch/bridge/config-integrations.js';

export type UserConfigFormat = 'toml';
export type UnknownRecord = Record<string, unknown>;

export interface DecodedUserConfigFile {
  path: string;
  format: UserConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

type ReadFileSyncLike = Pick<typeof import('node:fs'), 'readFileSync'>;

export function detectUserConfigFormat(configPath: string): UserConfigFormat {
  return detectRouteCodexUserConfigFormatSync(configPath);
}

export function parseUserConfigText(raw: string, format: UserConfigFormat): UnknownRecord {
  if (format === 'toml') {
    return decodeRouteCodexUserConfigTextSync({ raw }).parsed;
  }
  throw new Error('[config] user config JSON support removed; parser only accepts TOML');
}

export async function decodeUserConfigFile(configPath: string): Promise<DecodedUserConfigFile> {
  detectUserConfigFormat(configPath);
  const raw = await fs.readFile(configPath, 'utf8');
  const decoded = decodeRouteCodexUserConfigTextSync({ raw, configPath });
  return {
    path: configPath,
    format: decoded.format,
    raw,
    parsed: decoded.parsed,
  };
}

export function decodeUserConfigFileSync(
  configPath: string,
  fsImpl: ReadFileSyncLike
): DecodedUserConfigFile {
  detectUserConfigFormat(configPath);
  const raw = fsImpl.readFileSync(configPath, 'utf8');
  const decoded = decodeRouteCodexUserConfigTextSync({ raw, configPath });
  return {
    path: configPath,
    format: decoded.format,
    raw,
    parsed: decoded.parsed,
  };
}
