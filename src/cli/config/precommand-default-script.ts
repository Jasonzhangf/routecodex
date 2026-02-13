import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PRECOMMAND_SCRIPT = 'default.sh';
const DEFAULT_PRECOMMAND_SCRIPT_CONTENT = [
  '#!/usr/bin/env bash',
  '# RouteCodex default precommand hook (no-op).',
  '# You can edit this file to customize precommand behavior.',
  'exit 0',
  ''
].join('\n');

type FsLike = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'writeFileSync'>;
type PathLike = Pick<typeof path, 'join'>;

export type EnsureDefaultPrecommandScriptResult = {
  ok: boolean;
  created: boolean;
  scriptPath: string;
  message?: string;
};

export function resolveRoutecodexUserDir(homeDir?: string): string {
  const override = String(process.env.ROUTECODEX_USER_DIR || '').trim();
  if (override) {
    return override;
  }
  const resolvedHome = typeof homeDir === 'string' && homeDir.trim() ? homeDir.trim() : os.homedir();
  return path.join(resolvedHome, '.routecodex');
}

export function ensureDefaultPrecommandScriptBestEffort(options?: {
  fsImpl?: FsLike;
  pathImpl?: PathLike;
  homeDir?: string;
}): EnsureDefaultPrecommandScriptResult {
  const fsImpl = options?.fsImpl ?? fs;
  const pathImpl = options?.pathImpl ?? path;
  const userDir = resolveRoutecodexUserDir(options?.homeDir);
  const precommandDir = pathImpl.join(userDir, 'precommand');
  const scriptPath = pathImpl.join(precommandDir, DEFAULT_PRECOMMAND_SCRIPT);

  try {
    if (fsImpl.existsSync(scriptPath)) {
      return { ok: true, created: false, scriptPath };
    }
    fsImpl.mkdirSync(precommandDir, { recursive: true });
    if (!fsImpl.existsSync(scriptPath)) {
      fsImpl.writeFileSync(scriptPath, DEFAULT_PRECOMMAND_SCRIPT_CONTENT, { encoding: 'utf8', mode: 0o755 });
      return { ok: true, created: true, scriptPath };
    }
    return { ok: true, created: false, scriptPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      created: false,
      scriptPath,
      message
    };
  }
}
