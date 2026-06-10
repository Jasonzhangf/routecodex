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
  if (format === 'toml') {
    return serializeTomlRecord(parsed);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
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
  const raw = decoded.format === 'toml'
    ? updateTomlStringScalarInTable(decoded.raw, options.tablePath, options.key, options.value)
    : `${JSON.stringify(applyJsonStringScalarUpdate(decoded.parsed, options.tablePath, options.key, options.value), null, 2)}\n`;
  await writeRawConfigAtomically(options.configPath, raw);
  const persisted = await decodeUserConfigFile(options.configPath);
  return persisted;
}

function applyJsonStringScalarUpdate(
  parsed: UnknownRecord,
  tablePath: string[],
  key: string,
  value: string
): UnknownRecord {
  const root: UnknownRecord = structuredClone(parsed);
  let cursor: UnknownRecord = root;
  for (const segment of tablePath) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as UnknownRecord;
  }
  cursor[key] = value;
  return root;
}
