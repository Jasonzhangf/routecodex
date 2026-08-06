import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

export function isDirectExecution(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }
  try {
    const resolvedArgv = path.resolve(argv1);
    const argvCandidates = new Set<string>([
      pathToFileURL(resolvedArgv).href
    ]);
    try {
      argvCandidates.add(pathToFileURL(fs.realpathSync(resolvedArgv)).href);
    } catch {
      // Keep the resolved-path comparison only.
    }
    if (argvCandidates.has(importMetaUrl)) {
      return true;
    }
    try {
      const importPath = fs.realpathSync(new URL(importMetaUrl));
      return argvCandidates.has(pathToFileURL(importPath).href);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
