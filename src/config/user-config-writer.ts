// feature_id: config.user_config_write_surface
import fs from 'node:fs/promises';

import type { UnknownRecord, UserConfigFormat } from './user-config-codec.js';
import { decodeUserConfigFile, detectUserConfigFormat } from './user-config-codec.js';
import { serializeTomlRecord } from './toml-basic.js';
import { updateTomlStringScalarInTable } from './toml-comment-preserving.js';

export interface PersistedUserConfigFile {
  path: string;
  format: UserConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

function stringifyUserConfig(parsed: UnknownRecord, format: UserConfigFormat): string {
  if (format !== 'toml') {
    throw new Error('[config] user config JSON support removed; writer only accepts TOML');
  }
  return serializeTomlRecord(parsed);
}

async function writeRawConfigAtomically(configPath: string, raw: string): Promise<void> {
  const wroteAtMs = Date.now();
  const tmpPath = `${configPath}.tmp.${process.pid}.${wroteAtMs}`;
  await fs.writeFile(tmpPath, raw, 'utf8');
  await fs.rename(tmpPath, configPath);
}

export async function writeUserConfigFile(
  configPath: string,
  parsed: UnknownRecord,
  format?: UserConfigFormat
): Promise<PersistedUserConfigFile> {
  const nextFormat = format ?? detectUserConfigFormat(configPath);
  const raw = stringifyUserConfig(parsed, nextFormat);
  await writeRawConfigAtomically(configPath, raw);
  return {
    path: configPath,
    format: nextFormat,
    raw,
    parsed,
  };
}

export async function updateUserConfigStringScalar(options: {
  configPath: string;
  tablePath: string[];
  key: string;
  value: string;
}): Promise<PersistedUserConfigFile> {
  const decoded = await decodeUserConfigFile(options.configPath);
  const raw = updateTomlStringScalarInTable(decoded.raw, options.tablePath, options.key, options.value);
  await writeRawConfigAtomically(options.configPath, raw);
  const persisted = await decodeUserConfigFile(options.configPath);
  return persisted;
}
