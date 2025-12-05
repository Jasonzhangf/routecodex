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
  // Use the unified resolver for consistent behavior; do not fall back to legacy search
  const result = UnifiedConfigPathResolver.resolveConfigPath({
    preferredPath,
    allowDirectoryScan: true,
    strict: false
  });
  return result.resolvedPath;
}

/**
 * Legacy configuration path resolution (kept for emergency fallback)
 * @deprecated Use UnifiedConfigPathResolver instead
 */
// Legacy resolver removed: unified resolver is the single source of truth
