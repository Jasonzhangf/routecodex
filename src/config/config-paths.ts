import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

/**
 * Resolve the primary RouteCodex configuration file path using a shared precedence order.
 * Optional explicit path takes priority, followed by environment overrides and fallbacks.
 */
export function resolveRouteCodexConfigPath(preferredPath?: string): string {
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
    path.join(homedir(), '.routecodex', 'routecodex.json')
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore filesystem errors for non-existent paths
    }
  }

  return './routecodex.json';
}
