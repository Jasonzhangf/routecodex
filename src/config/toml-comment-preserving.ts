// feature_id: config.toml_codec
// feature_id: config.user_config_write_surface
import { updateRouteCodexTomlStringScalarInTableSync } from '../modules/llmswitch/bridge/config-integrations.js';

// Rust owner anchor: update_toml_string_scalar_in_table_json.
export function updateTomlStringScalarInTable(
  raw: string,
  tablePath: string[],
  key: string,
  value: string
): string {
  return updateRouteCodexTomlStringScalarInTableSync({ raw, tablePath, key, value });
}
