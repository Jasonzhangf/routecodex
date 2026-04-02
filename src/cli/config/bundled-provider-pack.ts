import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRccProviderDir } from '../../config/user-data-paths.js';

type BundledProviderManifest = {
  version?: string;
  profile?: string;
  providers?: string[];
};

export type BundledProviderPackInstallResult =
  | {
      ok: true;
      sourceDir: string;
      providerRoot: string;
      copiedProviders: string[];
      skippedProviders: string[];
    }
  | { ok: false; reason: 'missing_source' | 'invalid_manifest' | 'install_failed'; message: string };

function resolvePackageRootFromHere(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  // dist/cli/config/bundled-provider-pack.js -> ../.. = dist
  // dist -> .. = package root
  const distDir = path.resolve(dir, '..', '..');
  return path.resolve(distDir, '..');
}

function resolveBundledProviderSourceDir(fsImpl: typeof fs, pathImpl: typeof path): string | null {
  const pkgRoot = resolvePackageRootFromHere();
  const candidateDirs = [
    pathImpl.join(pkgRoot, 'configsamples', 'provider-default'),
    pathImpl.join(pkgRoot, 'dist', 'configsamples', 'provider-default')
  ];
  for (const candidate of candidateDirs) {
    try {
      const manifestPath = pathImpl.join(candidate, 'manifest.json');
      if (fsImpl.existsSync(manifestPath)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function parseManifest(raw: string): BundledProviderManifest | null {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as BundledProviderManifest;
  } catch {
    return null;
  }
}

export function installBundledProviderPackBestEffort(opts?: {
  fsImpl?: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'resolve' | 'dirname'>;
  providerRoot?: string;
  sourceDir?: string;
  overwriteExisting?: boolean;
}): BundledProviderPackInstallResult {
  const fsImpl = (opts?.fsImpl ?? fs) as typeof fs;
  const pathImpl = (opts?.pathImpl ?? path) as typeof path;
  const sourceDir = opts?.sourceDir ?? resolveBundledProviderSourceDir(fsImpl, pathImpl);
  if (!sourceDir) {
    return {
      ok: false,
      reason: 'missing_source',
      message: 'Bundled provider pack source directory not found in package'
    };
  }
  if (!fsImpl.existsSync(sourceDir)) {
    return {
      ok: false,
      reason: 'missing_source',
      message: `Bundled provider pack source directory not found: ${sourceDir}`
    };
  }

  const providerRoot = opts?.providerRoot ?? resolveRccProviderDir();
  const manifestPath = pathImpl.join(sourceDir, 'manifest.json');
  if (!fsImpl.existsSync(manifestPath)) {
    return {
      ok: false,
      reason: 'invalid_manifest',
      message: `Bundled provider pack manifest not found: ${manifestPath}`
    };
  }

  let manifest: BundledProviderManifest | null = null;
  try {
    manifest = parseManifest(fsImpl.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'install_failed',
      message: `Failed to read provider manifest: ${message}`
    };
  }
  const providers = Array.isArray(manifest?.providers)
    ? manifest.providers.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
    : [];
  if (!providers.length) {
    return {
      ok: false,
      reason: 'invalid_manifest',
      message: 'Bundled provider pack manifest has no providers'
    };
  }

  try {
    if (!fsImpl.existsSync(providerRoot)) {
      fsImpl.mkdirSync(providerRoot, { recursive: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'install_failed',
      message: `Failed to create provider root: ${message}`
    };
  }

  const copiedProviders: string[] = [];
  const skippedProviders: string[] = [];
  const overwriteExisting = Boolean(opts?.overwriteExisting);

  for (const providerId of providers) {
    const src = pathImpl.join(sourceDir, providerId, 'config.v2.json');
    const dst = pathImpl.join(providerRoot, providerId, 'config.v2.json');
    try {
      if (!fsImpl.existsSync(src)) {
        skippedProviders.push(providerId);
        continue;
      }
      if (fsImpl.existsSync(dst) && !overwriteExisting) {
        skippedProviders.push(providerId);
        continue;
      }
      const dstDir = pathImpl.dirname(dst);
      if (!fsImpl.existsSync(dstDir)) {
        fsImpl.mkdirSync(dstDir, { recursive: true });
      }
      const content = fsImpl.readFileSync(src, 'utf8');
      fsImpl.writeFileSync(dst, content, 'utf8');
      copiedProviders.push(providerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: 'install_failed',
        message: `Failed to install provider "${providerId}": ${message}`
      };
    }
  }

  return {
    ok: true,
    sourceDir,
    providerRoot,
    copiedProviders,
    skippedProviders
  };
}
