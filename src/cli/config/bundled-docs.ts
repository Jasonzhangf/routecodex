import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROUTECODEX_BUNDLED_DOC_FILES = [
  'INSTALLATION_AND_QUICKSTART.md',
  'PROVIDERS_BUILTIN.md',
  'PROVIDER_TYPES.md',
  'INSTRUCTION_MARKUP.md',
  'PORTS.md',
  'CODEX_AND_CLAUDE_CODE.md'
] as const;

export type BundledDocsInstallResult =
  | { ok: true; sourceDir: string; targetDir: string; copied: string[]; skipped: string[] }
  | { ok: false; reason: 'missing_source' | 'install_failed'; message: string };

function resolveUserDir(): string {
  const override = String(process.env.ROUTECODEX_USER_DIR || '').trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.routecodex');
}

function resolvePackageRootFromHere(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  // dist/cli/config/bundled-docs.js -> ../../.. = dist
  // dist -> .. = package root
  const distDir = path.resolve(dir, '..', '..', '..');
  const rootDir = path.resolve(distDir, '..');
  return rootDir;
}

function resolveBundledDocsSourceDir(fsImpl: typeof fs, pathImpl: typeof path): string | null {
  const pkgRoot = resolvePackageRootFromHere();
  const candidateDirs = [
    pathImpl.join(pkgRoot, 'docs'),
    pathImpl.join(pkgRoot, 'dist', 'docs')
  ];
  for (const candidate of candidateDirs) {
    try {
      const sentinel = pathImpl.join(candidate, ROUTECODEX_BUNDLED_DOC_FILES[0]);
      if (fsImpl.existsSync(sentinel)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function installBundledDocsBestEffort(opts?: {
  fsImpl?: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'resolve'>;
  userDir?: string;
  docsSourceDir?: string;
}): BundledDocsInstallResult {
  const fsImpl = (opts?.fsImpl ?? fs) as typeof fs;
  const pathImpl = (opts?.pathImpl ?? path) as typeof path;

  const sourceDir = opts?.docsSourceDir ?? resolveBundledDocsSourceDir(fsImpl, pathImpl);
  if (!sourceDir) {
    return {
      ok: false,
      reason: 'missing_source',
      message: 'Bundled docs source directory not found in package'
    };
  }

  const userDir = opts?.userDir ?? resolveUserDir();
  const targetDir = pathImpl.join(userDir, 'docs');

  try {
    if (!fsImpl.existsSync(targetDir)) {
      fsImpl.mkdirSync(targetDir, { recursive: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'install_failed', message: `Failed to create docs dir: ${message}` };
  }

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const name of ROUTECODEX_BUNDLED_DOC_FILES) {
    const src = pathImpl.join(sourceDir, name);
    const dst = pathImpl.join(targetDir, name);
    try {
      if (!fsImpl.existsSync(src)) {
        skipped.push(name);
        continue;
      }
      const content = fsImpl.readFileSync(src, 'utf8');
      fsImpl.writeFileSync(dst, content, 'utf8');
      copied.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'install_failed', message: `Failed to copy ${name}: ${message}` };
    }
  }

  return { ok: true, sourceDir, targetDir, copied, skipped };
}

