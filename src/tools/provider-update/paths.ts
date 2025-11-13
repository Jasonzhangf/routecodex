import path from 'path';
import { homedir } from 'os';

export function getProviderRootDir(providerId: string, overrideDir?: string): string {
  if (overrideDir && overrideDir.trim()) return path.resolve(overrideDir);
  return path.join(homedir(), '.routecodex', 'provider', providerId);
}

export function getBlacklistPath(providerId: string, overrideDir?: string, explicitFile?: string): string {
  if (explicitFile && explicitFile.trim()) return path.resolve(explicitFile);
  return path.join(getProviderRootDir(providerId, overrideDir), 'blacklist.json');
}

export function getModelsCachePath(providerId: string, overrideDir?: string): string {
  return path.join(getProviderRootDir(providerId, overrideDir), 'models-latest.json');
}

export function getProviderConfigOutputPath(providerId: string, overrideDir?: string): string {
  return path.join(getProviderRootDir(providerId, overrideDir), 'config.json');
}

