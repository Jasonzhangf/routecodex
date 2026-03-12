import fs from 'node:fs';
import path from 'node:path';
import { resolveRccPrecommandDir, resolveRccUserDir } from '../../config/user-data-paths.js';

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
  return resolveRccUserDir(homeDir);
}

export function ensureDefaultPrecommandScriptBestEffort(options?: {
  fsImpl?: FsLike;
  pathImpl?: PathLike;
  homeDir?: string;
}): EnsureDefaultPrecommandScriptResult {
  const fsImpl = options?.fsImpl ?? fs;
  const pathImpl = options?.pathImpl ?? path;
  const precommandDir = resolveRccPrecommandDir(options?.homeDir);
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
