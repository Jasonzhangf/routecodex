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
  const result = UnifiedConfigPathResolver.resolveConfigPath({
    preferredPath,
    allowDirectoryScan: true
  });
  return result.resolvedPath;
}
