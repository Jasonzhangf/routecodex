// Enhanced path resolver for host application roots and config directory
// Strategy:
// 1) Prefer process.cwd()/config when present
// 2) If running from inside llmswitch-core dist, scan upward to find a dir that contains 'config'
// 3) Fallback to 'config' relative to current module

import path from 'path';
import fs from 'fs';

export interface ResolvedPaths {
  hostRoot: string;
  configDir: string;
}

export function resolveHostPaths(): ResolvedPaths {
  // Attempt 1: process.cwd()
  try {
    const cwd = process.cwd();
    const cfg = path.join(cwd, 'config');
    if (fs.existsSync(cfg)) {
      return { hostRoot: cwd, configDir: cfg };
    }
  } catch {
    /* ignore */
  }

  // Attempt 2: scan upward from this file
  try {
    let cur = path.dirname(new URL(import.meta.url).pathname);
    const visited = new Set<string>();
    for (let i = 0; i < 10; i++) {
      if (visited.has(cur)) {
        break;
      }
      visited.add(cur);
      const cfg = path.join(cur, 'config');
      if (fs.existsSync(cfg)) {
        return { hostRoot: cur, configDir: cfg };
      }
      const parent = path.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
  } catch {
    /* ignore */
  }

  // Fallback to relative 'config'
  const fallbackRoot = process.cwd();
  return { hostRoot: fallbackRoot, configDir: path.join(fallbackRoot, 'config') };
}
