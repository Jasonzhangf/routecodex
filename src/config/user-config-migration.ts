import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';

import { resolveLegacyRouteCodexUserDir, resolveRccUserDir } from './user-data-paths.js';

type MigrationEntry = {
  id: 'config_file' | 'config_dir' | 'provider_dir';
  kind: 'file' | 'dir';
  legacyRelativePath: string;
  targetRelativePath: string;
  skipRelativeSegments?: readonly string[];
};

const USER_CONFIG_MIGRATION_ENTRIES: readonly MigrationEntry[] = [
  {
    id: 'config_file',
    kind: 'file',
    legacyRelativePath: 'config.json',
    targetRelativePath: 'config.json'
  },
  {
    id: 'config_dir',
    kind: 'dir',
    legacyRelativePath: 'config',
    targetRelativePath: 'config'
  },
  {
    id: 'provider_dir',
    kind: 'dir',
    legacyRelativePath: 'provider',
    targetRelativePath: 'provider',
    skipRelativeSegments: ['samples']
  }
] as const;

export type UserConfigMigrationAction = 'copy' | 'overwrite' | 'unchanged' | 'conflict';

export type UserConfigMigrationItem = {
  entryId: MigrationEntry['id'];
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  action: UserConfigMigrationAction;
  bytes: number;
};

export type UserConfigMigrationSummary = {
  total: number;
  copy: number;
  overwrite: number;
  unchanged: number;
  conflict: number;
  missingRoots: string[];
};

export type UserConfigMigrationPlan = {
  legacyRoot: string;
  targetRoot: string;
  overwrite: boolean;
  items: UserConfigMigrationItem[];
  summary: UserConfigMigrationSummary;
};

export type UserConfigMigrationApplyResult = {
  copied: number;
  overwritten: number;
  skippedConflicts: number;
};

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fsAsync.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function areFilesEqual(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    const [source, target] = await Promise.all([fsAsync.readFile(sourcePath), fsAsync.readFile(targetPath)]);
    return source.equals(target);
  } catch {
    return false;
  }
}

function collectFilesUnderDir(baseDir: string, relativePrefix = ''): string[] {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') {
      continue;
    }
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
    const absolutePath = path.join(baseDir, entry.name);
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      files.push(...collectFilesUnderDir(absolutePath, relativePath));
      continue;
    }
    if (stats.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function shouldSkipRelativePath(relativePath: string, skipRelativeSegments: readonly string[] | undefined): boolean {
  if (!skipRelativeSegments || skipRelativeSegments.length === 0) {
    return false;
  }
  const normalizedParts = relativePath.split(path.sep).filter(Boolean);
  return normalizedParts.some((part) => skipRelativeSegments.includes(part));
}

async function collectEntryItems(
  entry: MigrationEntry,
  legacyRoot: string,
  targetRoot: string,
  overwrite: boolean
): Promise<{ missingRoot?: string; items: UserConfigMigrationItem[] }> {
  const sourceRoot = path.join(legacyRoot, entry.legacyRelativePath);
  if (!fs.existsSync(sourceRoot)) {
    return { missingRoot: entry.legacyRelativePath, items: [] };
  }

  const sourceStats = fs.lstatSync(sourceRoot);
  if (sourceStats.isSymbolicLink()) {
    return { missingRoot: entry.legacyRelativePath, items: [] };
  }

  const relativeFiles =
    entry.kind === 'file'
      ? sourceStats.isFile()
        ? ['']
        : []
      : sourceStats.isDirectory()
        ? collectFilesUnderDir(sourceRoot)
        : [];

  const items: UserConfigMigrationItem[] = [];
  for (const relativePath of relativeFiles) {
    if (shouldSkipRelativePath(relativePath, entry.skipRelativeSegments)) {
      continue;
    }
    const sourcePath = relativePath ? path.join(sourceRoot, relativePath) : sourceRoot;
    const targetPath = relativePath
      ? path.join(targetRoot, entry.targetRelativePath, relativePath)
      : path.join(targetRoot, entry.targetRelativePath);
    const sourceFileStats = await fsAsync.stat(sourcePath);
    const targetExists = await fileExists(targetPath);
    let action: UserConfigMigrationAction = 'copy';
    if (targetExists) {
      const same = await areFilesEqual(sourcePath, targetPath);
      if (same) {
        action = 'unchanged';
      } else {
        action = overwrite ? 'overwrite' : 'conflict';
      }
    }
    items.push({
      entryId: entry.id,
      relativePath: relativePath || path.basename(entry.targetRelativePath),
      sourcePath,
      targetPath,
      action,
      bytes: sourceFileStats.size
    });
  }
  return { items };
}

export async function collectUserConfigMigrationPlan(options?: {
  homeDir?: string;
  overwrite?: boolean;
}): Promise<UserConfigMigrationPlan> {
  const homeDir = options?.homeDir;
  const overwrite = options?.overwrite === true;
  const legacyRoot = resolveLegacyRouteCodexUserDir(homeDir);
  const targetRoot = resolveRccUserDir(homeDir);

  const items: UserConfigMigrationItem[] = [];
  const missingRoots: string[] = [];
  for (const entry of USER_CONFIG_MIGRATION_ENTRIES) {
    const result = await collectEntryItems(entry, legacyRoot, targetRoot, overwrite);
    if (result.missingRoot) {
      missingRoots.push(result.missingRoot);
    }
    items.push(...result.items);
  }

  items.sort((left, right) => left.targetPath.localeCompare(right.targetPath));

  const summary: UserConfigMigrationSummary = {
    total: items.length,
    copy: items.filter((item) => item.action === 'copy').length,
    overwrite: items.filter((item) => item.action === 'overwrite').length,
    unchanged: items.filter((item) => item.action === 'unchanged').length,
    conflict: items.filter((item) => item.action === 'conflict').length,
    missingRoots
  };

  return {
    legacyRoot,
    targetRoot,
    overwrite,
    items,
    summary
  };
}

export async function applyUserConfigMigrationPlan(plan: UserConfigMigrationPlan): Promise<UserConfigMigrationApplyResult> {
  let copied = 0;
  let overwritten = 0;
  let skippedConflicts = 0;

  for (const item of plan.items) {
    if (item.action === 'unchanged') {
      continue;
    }
    if (item.action === 'conflict') {
      skippedConflicts += 1;
      continue;
    }
    await fsAsync.mkdir(path.dirname(item.targetPath), { recursive: true });
    await fsAsync.copyFile(item.sourcePath, item.targetPath);
    const stats = await fsAsync.stat(item.sourcePath);
    await fsAsync.chmod(item.targetPath, stats.mode);
    if (item.action === 'copy') {
      copied += 1;
    } else {
      overwritten += 1;
    }
  }

  return {
    copied,
    overwritten,
    skippedConflicts
  };
}
