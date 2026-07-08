// feature_id: config.user_config_codec
// feature_id: config.provider_config_codec
// Rust SSOT: sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/config_toml_codec.rs
import {
  parseRouteCodexTomlRecordSync,
  serializeRouteCodexTomlRecordSync
} from '../modules/llmswitch/bridge/routing-integrations.js';

export type TomlPrimitive = string | number | boolean;
export interface TomlTable {
  [key: string]: TomlValue;
}
export type TomlValue = TomlPrimitive | TomlValue[] | TomlTable;

export function parseTomlRecord(raw: string): Record<string, unknown> {
  return parseRouteCodexTomlRecordSync(raw);
}

export function serializeTomlRecord(obj: Record<string, unknown>): string {
  return serializeRouteCodexTomlRecordSync(obj);
}
