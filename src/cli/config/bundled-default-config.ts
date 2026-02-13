import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTECODEX_BUNDLED_DEFAULT_CONFIG_FILE = 'config.v1.quickstart.sanitized.json' as const;

export type BundledDefaultConfigInstallResult =
  | { ok: true; sourcePath: string; targetPath: string }
  | { ok: false; reason: 'missing_source' | 'install_failed'; message: string };

function resolvePackageRootFromHere(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  // dist/cli/config/bundled-default-config.js -> ../.. = dist
  // dist -> .. = package root
  const distDir = path.resolve(dir, '..', '..');
  const rootDir = path.resolve(distDir, '..');
  return rootDir;
}

function resolveBundledDefaultConfigSourcePath(
  fsImpl: typeof fs,
  pathImpl: typeof path
): string | null {
  const pkgRoot = resolvePackageRootFromHere();
  const candidates = [
    pathImpl.join(pkgRoot, 'configsamples', ROUTECODEX_BUNDLED_DEFAULT_CONFIG_FILE),
    pathImpl.join(pkgRoot, 'dist', 'configsamples', ROUTECODEX_BUNDLED_DEFAULT_CONFIG_FILE)
  ];
  for (const candidate of candidates) {
    try {
      if (fsImpl.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function installBundledDefaultConfigBestEffort(opts: {
  targetConfigPath: string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'dirname' | 'resolve'>;
  sourceConfigPath?: string;
}): BundledDefaultConfigInstallResult {
  const fsImpl = (opts.fsImpl ?? fs) as typeof fs;
  const pathImpl = (opts.pathImpl ?? path) as typeof path;
  const sourcePath = opts.sourceConfigPath ?? resolveBundledDefaultConfigSourcePath(fsImpl, pathImpl);

  if (!sourcePath) {
    return {
      ok: false,
      reason: 'missing_source',
      message: `Bundled default config not found: ${ROUTECODEX_BUNDLED_DEFAULT_CONFIG_FILE}`
    };
  }

  const targetPath = pathImpl.resolve(opts.targetConfigPath);
  const targetDir = pathImpl.dirname(targetPath);

  try {
    if (!fsImpl.existsSync(targetDir)) {
      fsImpl.mkdirSync(targetDir, { recursive: true });
    }
    const content = fsImpl.readFileSync(sourcePath, 'utf8');
    fsImpl.writeFileSync(targetPath, content, 'utf8');
    return { ok: true, sourcePath, targetPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'install_failed',
      message: `Failed to install bundled default config: ${message}`
    };
  }
}

