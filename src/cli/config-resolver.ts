import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS, DEFAULT_CONFIG } from '../constants/index.js';

export interface ResolvedConfigInfo {
  configPath: string;
  config: any;
}

export function resolveConfigPath(cliPath?: string): string {
  if (cliPath && cliPath.trim()) return cliPath;
  return path.join(homedir(), '.routecodex', 'config.json');
}

export function readConfig(configPath: string): any {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }
  const txt = fs.readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`Invalid JSON in configuration file: ${configPath}`);
  }
}

export function resolveEffectivePort(config: any, isDevPackage: boolean): number {
  if (isDevPackage) {
    const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
    if (!Number.isNaN(envPort) && envPort > 0) return envPort;
    return 5555; // dev 固定端口（默认）
  }
  const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
  if (!port || typeof port !== 'number' || port <= 0) {
    throw new Error('Invalid or missing port configuration');
  }
  return port;
}

export function resolveHost(config: any): string {
  const v = (config?.httpserver?.host || config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST);
  // 归一化展示：避免 :: 等造成混乱
  if (v === '0.0.0.0' || v === '::' || v === '::1' || v === 'localhost') return LOCAL_HOSTS.IPV4;
  return v;
}

export function getModulesConfigPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../config/modules.json');
}

