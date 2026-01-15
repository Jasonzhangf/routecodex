import path from 'path';
import { pathToFileURL } from 'url';

export function isDirectExecution(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }
  try {
    const argvUrl = pathToFileURL(path.resolve(argv1)).href;
    return importMetaUrl === argvUrl;
  } catch {
    return false;
  }
}

