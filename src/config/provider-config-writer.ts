// feature_id: config.provider_config_write_surface
import fs from 'node:fs/promises';

import type { ProviderConfigFormat } from './provider-config-codec.js';
import { detectProviderConfigFormat } from './provider-config-codec.js';
import { serializeTomlRecord } from './toml-basic.js';

type UnknownRecord = Record<string, unknown>;

export interface PersistedProviderConfigFile {
  path: string;
  format: ProviderConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

function stringifyProviderConfig(parsed: UnknownRecord, format: ProviderConfigFormat): string {
  if (format !== 'toml') {
    throw new Error('[config] provider config JSON support removed; writer only accepts TOML');
  }
  return serializeTomlRecord(parsed);
}

async function writeRawProviderConfigAtomically(configPath: string, raw: string): Promise<void> {
  const wroteAtMs = Date.now();
  const tmpPath = `${configPath}.tmp.${process.pid}.${wroteAtMs}`;
  await fs.writeFile(tmpPath, raw, 'utf8');
  await fs.rename(tmpPath, configPath);
}

type WriteFileSyncLike = Pick<typeof import('node:fs'), 'writeFileSync' | 'renameSync'>;

function writeRawProviderConfigAtomicallySync(
  configPath: string,
  raw: string,
  fsImpl: WriteFileSyncLike
): void {
  const wroteAtMs = Date.now();
  const tmpPath = `${configPath}.tmp.${process.pid}.${wroteAtMs}`;
  fsImpl.writeFileSync(tmpPath, raw, 'utf8');
  fsImpl.renameSync(tmpPath, configPath);
}

export async function writeProviderConfigFile(
  configPath: string,
  parsed: UnknownRecord,
  format?: ProviderConfigFormat
): Promise<PersistedProviderConfigFile> {
  const nextFormat = format ?? detectProviderConfigFormat(configPath);
  const raw = stringifyProviderConfig(parsed, nextFormat);
  await writeRawProviderConfigAtomically(configPath, raw);
  return {
    path: configPath,
    format: nextFormat,
    raw,
    parsed,
  };
}

export function writeProviderConfigFileSync(
  configPath: string,
  parsed: UnknownRecord,
  fsImpl: WriteFileSyncLike,
  format?: ProviderConfigFormat
): PersistedProviderConfigFile {
  const nextFormat = format ?? detectProviderConfigFormat(configPath);
  const raw = stringifyProviderConfig(parsed, nextFormat);
  writeRawProviderConfigAtomicallySync(configPath, raw, fsImpl);
  return {
    path: configPath,
    format: nextFormat,
    raw,
    parsed,
  };
}
