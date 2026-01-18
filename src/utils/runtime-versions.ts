import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedLlmsVersion: string | null | undefined;

export function resolveLlmswitchCoreVersion(): string | undefined {
  if (cachedLlmsVersion !== undefined) {
    return cachedLlmsVersion ?? undefined;
  }
  cachedLlmsVersion = null;

  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(moduleDir, '..', '..');
    const candidates = [
      path.resolve(process.cwd(), 'node_modules', '@jsonstudio', 'llms', 'package.json'),
      path.resolve(packageRoot, 'node_modules', '@jsonstudio', 'llms', 'package.json')
    ];

    for (const pkgPath of candidates) {
      try {
        if (!fs.existsSync(pkgPath)) continue;
        const text = fs.readFileSync(pkgPath, 'utf-8');
        const parsed = JSON.parse(text) as { version?: unknown };
        if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
          cachedLlmsVersion = parsed.version.trim();
          return cachedLlmsVersion;
        }
      } catch {
        // try next
      }
    }
  } catch {
    cachedLlmsVersion = null;
  }
  return undefined;
}
