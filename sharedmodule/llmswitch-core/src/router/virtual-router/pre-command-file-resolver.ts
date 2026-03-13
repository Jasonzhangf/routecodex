import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveRccUserDir
} from '../../runtime/user-data-paths.js';

const DEFAULT_PRECOMMAND_SCRIPT = 'default.sh';
const DEFAULT_PRECOMMAND_SCRIPT_CONTENT = [
  '#!/usr/bin/env bash',
  '# RouteCodex default precommand hook (no-op).',
  '# You can edit this file to customize precommand behavior.',
  'exit 0',
  ''
].join('\n');

function resolvePreCommandBaseDir(): string {
  return path.resolve(resolveRccUserDir(), 'precommand');
}

function normalizeRelativePath(raw: string): string {
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('precommand: invalid relative path');
  }
  return normalized;
}

function normalizePreCommandRelativePath(raw: string, fromFileScheme: boolean): string {
  const normalized = normalizeRelativePath(raw);
  if (normalized === 'precommand') {
    throw new Error('precommand: expected script file under ~/.rcc/precommand');
  }
  if (normalized.startsWith('precommand/')) {
    return normalized.slice('precommand/'.length);
  }
  if (fromFileScheme) {
    throw new Error('precommand file://: path must be under file://precommand/...');
  }
  return normalized;
}

export function resolvePreCommandScriptPath(raw: string): string {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    throw new Error('precommand: missing script path');
  }

  if (text.startsWith('<') && text.endsWith('>') && text.length >= 3) {
    text = text.slice(1, -1).trim();
  }

  const fromFileScheme = /^file:\/\//i.test(text);
  const relRaw = fromFileScheme ? text.slice('file://'.length).trim() : text;
  if (!relRaw) {
    throw new Error('precommand file://: missing relative path');
  }
  if (relRaw.startsWith('/') || relRaw.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(relRaw)) {
    throw new Error('precommand: only supports paths relative to ~/.rcc/precommand');
  }

  const relToPreCommand = normalizePreCommandRelativePath(relRaw, fromFileScheme);
  const selectedBase = resolvePreCommandBaseDir();
  const abs = path.resolve(selectedBase, relToPreCommand);

  if (abs !== selectedBase && !abs.startsWith(`${selectedBase}${path.sep}`)) {
    throw new Error('precommand: path escapes ~/.rcc/precommand');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err: any) {
    if (shouldAutoCreateDefaultScript(relToPreCommand, err)) {
      tryCreateDefaultPreCommandScript(selectedBase, abs);
      try {
        stat = fs.statSync(abs);
      } catch (retryErr: any) {
        const retryMessage =
          retryErr && typeof retryErr.message === 'string' ? retryErr.message : String(retryErr || 'unknown error');
        throw new Error(`precommand: cannot stat ${abs}: ${retryMessage}`);
      }
    } else {
      const message = err && typeof err.message === 'string' ? err.message : String(err || 'unknown error');
      throw new Error(`precommand: cannot stat ${abs}: ${message}`);
    }
  }
  if (!stat.isFile()) {
    throw new Error(`precommand: not a file: ${abs}`);
  }

  return abs;
}

function shouldAutoCreateDefaultScript(relToPreCommand: string, err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'ENOENT') {
    return false;
  }
  return relToPreCommand === DEFAULT_PRECOMMAND_SCRIPT;
}

function tryCreateDefaultPreCommandScript(baseDir: string, scriptPath: string): void {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    if (!fs.existsSync(scriptPath)) {
      fs.writeFileSync(scriptPath, DEFAULT_PRECOMMAND_SCRIPT_CONTENT, { encoding: 'utf8', mode: 0o755 });
    }
  } catch {
    // Keep original resolver contract: caller gets a stat error on failure.
  }
}

export function isPreCommandScriptPathAllowed(rawPath: string): boolean {
  const scriptPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!scriptPath) {
    return false;
  }
  const base = resolvePreCommandBaseDir();
  const abs = path.resolve(scriptPath);
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) {
    return false;
  }
  try {
    const stat = fs.statSync(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}
