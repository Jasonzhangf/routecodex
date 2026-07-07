// feature_id: config.path_resolution_surface
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import {
  resolveRccConfigDir,
  resolveRccUserDir
} from './user-data-paths.js';

/**
 * Unified Configuration Path Resolution System
 *
 * This system provides a single source of truth for RouteCodex user-config
 * path resolution. Auto-discovery is strict TOML-first and does not silently
 * fall back to legacy JSON filenames.
 */

export interface ConfigPathOptions {
  /** Explicit preferred path (highest priority) */
  preferredPath?: string;
  /** Specific configuration file name to look for */
  configName?: string;
  /** Whether to allow directory scanning for config files */
  allowDirectoryScan?: boolean;
  /** Base directory for configuration resolution */
  baseDir?: string;
}

export interface ConfigPathResult {
  /** The resolved configuration path */
  resolvedPath: string;
}

/**
 * Environment variable precedence order for configuration paths
 */
const ENVIRONMENT_VARIABLES = [
  'ROUTECODEX_CONFIG_PATH',  // Primary environment variable
  'ROUTECODEX_CONFIG'        // Alternative format
];

const DEFAULT_CONFIG_NAME = 'config.toml';

function safeProcessCwd(defaultValue?: string): string {
  try {
    const cwd = process.cwd();
    if (typeof cwd === 'string' && cwd.trim()) {
      return cwd;
    }
  } catch {
    // current working directory may no longer exist
  }
  const defaultValuePath = String(defaultValue || '').trim();
  if (defaultValuePath) {
    return path.resolve(defaultValuePath);
  }
  const home = homedir();
  if (typeof home === 'string' && home.trim()) {
    return path.resolve(home);
  }
  return path.dirname(process.execPath);
}

/**
 * Unified configuration path resolver
 */
export class UnifiedConfigPathResolver {
  /**
   * Resolve configuration path using unified precedence order
   */
  static resolveConfigPath(options: ConfigPathOptions = {}): ConfigPathResult {
    const {
      preferredPath,
      configName,
      allowDirectoryScan = true,
      baseDir = safeProcessCwd()
    } = options;

    const envVars: Record<string, string | undefined> = {};

    // Collect environment variables
    ENVIRONMENT_VARIABLES.forEach(envVar => {
      envVars[envVar] = process.env[envVar];
    });

    // Build candidate list in precedence order
    const candidateList = this.buildCandidateList({
      preferredPath,
      configName,
      allowDirectoryScan,
      baseDir,
      envVars
    });

    // Try to resolve from candidates
    for (const candidate of candidateList) {
      try {
        const expandedPath = this.expandPath(candidate);
        if (!expandedPath) {continue;}
        if (path.extname(expandedPath).trim().toLowerCase() === '.json') {
          throw new Error(`[config] user config JSON support removed; expected TOML file: ${expandedPath}`);
        }

        if (fs.existsSync(expandedPath)) {
          const stat = fs.statSync(expandedPath);

          if (stat.isFile()) {
            return {
              resolvedPath: expandedPath
            };
          }

          if (stat.isDirectory() && allowDirectoryScan) {
            const configFile = this.scanConfigDirectory(expandedPath, configName);
            if (configFile) {
              return {
                resolvedPath: configFile
              };
            }
          }
        }
      } catch (error) {
        throw new Error(`Filesystem error accessing ${candidate}: ${error}`);
      }
    }

    throw new Error(`No configuration file found. Searched: ${candidateList.join(', ')}.`);
  }

  /**
   * Scan a directory for configuration files
   */
  static scanConfigDirectory(directory: string, preferredName?: string): string | null {
    const expectedName = (preferredName || DEFAULT_CONFIG_NAME).toLowerCase();
    const entries = fs.readdirSync(directory);
    const found = entries.find(file => file.toLowerCase() === expectedName);
    return found ? path.join(directory, found) : null;
  }

  /**
   * Build candidate list for configuration resolution
   */
  private static buildCandidateList(options: {
    preferredPath?: string;
    configName?: string;
    allowDirectoryScan: boolean;
    baseDir: string;
    envVars: Record<string, string | undefined>;
  }): string[] {
    const { preferredPath, configName, allowDirectoryScan, baseDir, envVars } = options;
    const candidates: string[] = [];

    // 1. Explicit preferred path (highest priority)
    if (preferredPath) {
      candidates.push(preferredPath);
    }

    // 2. Environment variables
    ENVIRONMENT_VARIABLES.forEach(envVar => {
      if (envVars[envVar]) {
        candidates.push(envVars[envVar]!);
      }
    });

    // 3. Current directory configurations
    if (configName) {
      candidates.push(path.join(baseDir, configName));
      candidates.push(path.join(baseDir, 'config', configName));
    } else {
      candidates.push(path.join(baseDir, DEFAULT_CONFIG_NAME));
      candidates.push(path.join(baseDir, 'config', DEFAULT_CONFIG_NAME));
    }

    // 4. Home directory configurations
    if (configName) {
      const primaryHome = resolveRccUserDir();
      candidates.push(path.join(primaryHome, configName));
      candidates.push(path.join(primaryHome, 'config', configName));
    } else {
      const primaryHome = resolveRccUserDir();
      candidates.push(path.join(primaryHome, DEFAULT_CONFIG_NAME));
    }

    // 5. Default configuration directory (with scanning)
    const defaultConfigDir = resolveRccConfigDir();
    if (allowDirectoryScan) {
      candidates.push(resolveRccUserDir());
      candidates.push(defaultConfigDir);
    } else if (configName) {
      candidates.push(path.join(defaultConfigDir, configName));
    } else {
      candidates.push(path.join(defaultConfigDir, DEFAULT_CONFIG_NAME));
    }

    return candidates;
  }


  /**
   * Expand home directory in path
   */
  private static expandPath(pathString: string): string | null {
    if (!pathString) {return null;}
    return pathString.startsWith('~')
      ? pathString.replace('~', homedir())
      : pathString;
  }

}
