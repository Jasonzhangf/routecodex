// feature_id: config.user_config_write_surface
import type { UnknownRecord, UserConfigFormat } from './user-config-codec.js';
import { detectUserConfigFormat } from './user-config-codec.js';
import {
  updateRouteCodexUserConfigStringScalarNativeSync,
  writeRouteCodexUserConfigFileNativeSync
} from '../modules/llmswitch/bridge/routing-integrations.js';

export interface PersistedUserConfigFile {
  path: string;
  format: UserConfigFormat;
  raw: string;
  parsed: UnknownRecord;
}

export async function writeUserConfigFile(
  configPath: string,
  parsed: UnknownRecord,
  format?: UserConfigFormat
): Promise<PersistedUserConfigFile> {
  const nextFormat = format ?? detectUserConfigFormat(configPath);
  return writeRouteCodexUserConfigFileNativeSync({ configPath, parsed, format: nextFormat });
}

export async function updateUserConfigStringScalar(options: {
  configPath: string;
  tablePath: string[];
  key: string;
  value: string;
}): Promise<PersistedUserConfigFile> {
  return updateRouteCodexUserConfigStringScalarNativeSync(options);
}
