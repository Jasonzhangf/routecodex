import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { UnifiedConfigPathResolver } from './unified-config-paths.js';

/**
 * Resolve the primary RouteCodex configuration file path using a shared precedence order.
 *
 * This function now uses the UnifiedConfigPathResolver for consistent path resolution
 * across the entire RouteCodex system while maintaining backward compatibility.
 *
 * @param preferredPath - Optional explicit path that takes highest priority
 * @returns The resolved configuration file path
 */
export function resolveRouteCodexConfigPath(preferredPath?: string): string {
  try {
    // Use the unified resolver for consistent behavior
    const result = UnifiedConfigPathResolver.resolveConfigPath({
      preferredPath,
      allowDirectoryScan: true,
      strict: false
    });

    return result.resolvedPath;
  } catch (error) {
    // Fallback to legacy behavior if unified resolver fails
    console.warn('Unified config path resolution failed, using fallback:', error);
    return legacyResolveRouteCodexConfigPath(preferredPath);
  }
}

/**
 * Legacy configuration path resolution (kept for emergency fallback)
 * @deprecated Use UnifiedConfigPathResolver instead
 */
function legacyResolveRouteCodexConfigPath(preferredPath?: string): string {
  const candidates = [
    preferredPath,
    process.env.RCC4_CONFIG_PATH,
    // Back-compat with docs/env usage
    process.env.ROUTECODEX_CONFIG_PATH,
    process.env.ROUTECODEX_CONFIG,
    './routecodex.json',
    './config/routecodex.json',
    path.join(process.cwd(), 'routecodex.json'),
    path.join(homedir(), '.routecodex', 'config.json'),
    path.join(homedir(), '.routecodex', 'routecodex.json'),
    path.join(homedir(), '.routecodex', 'config')
  ];

  const tryResolveFromDir = (dirPath: string): string | null => {
    try {
      const entries = fs.readdirSync(dirPath)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map(f => ({
          name: f,
          mtime: fs.statSync(path.join(dirPath, f)).mtimeMs
        }));
      if (entries.length === 0) {return null;}

      // Prefer common names if present
      const preferredNames = ['glm.json', 'routecodex.json', 'config.json'];
      for (const name of preferredNames) {
        const hit = entries.find(e => e.name.toLowerCase() === name);
        if (hit) {return path.join(dirPath, hit.name);}
      }

      // Otherwise pick most recently modified
      entries.sort((a, b) => b.mtime - a.mtime);
      return path.join(dirPath, entries[0].name);
    } catch {
      return null;
    }
  };

  const expandHome = (p?: string | null): string | null => {
    if (!p) {return null;}
    return p.startsWith('~') ? p.replace('~', homedir()) : p;
  };

  for (const rawCandidate of candidates) {
    const candidate = expandHome(rawCandidate);
    if (!candidate) {
      continue;
    }

    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.isDirectory()) {
          const file = tryResolveFromDir(candidate);
          if (file) {return file;}
          continue;
        }
        if (stat.isFile()) {
          return candidate;
        }
      }
    } catch {
      // Ignore filesystem errors for non-existent paths
    }
  }

  return './routecodex.json';
}
