// feature_id: config.path_resolution_surface
import { resolveRouteCodexConfigPathNativeSync } from '../modules/llmswitch/bridge/config-integrations.js';

export interface ConfigPathOptions {
  preferredPath?: string;
  configName?: string;
  allowDirectoryScan?: boolean;
  baseDir?: string;
}

export interface ConfigPathResult {
  resolvedPath: string;
}

export class UnifiedConfigPathResolver {
  static resolveConfigPath(options: ConfigPathOptions = {}): ConfigPathResult {
    return {
      resolvedPath: resolveRouteCodexConfigPathNativeSync(options)
    };
  }
}
