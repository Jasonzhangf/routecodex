/**
 * Launcher Types
 *
 * Type definitions for the launcher kernel module.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type fs from 'node:fs';
import type path from 'node:path';
import type { spawnSync } from 'node:child_process';
import type { GuardianLifecycleEvent, GuardianRegistration } from '../../guardian/types.js';

export type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

export type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

export type LauncherCommandContext = {
  isDevPackage: boolean;
  isWindows: boolean;
  defaultDevPort: number;
  nodeBin: string;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  env: NodeJS.ProcessEnv;
  rawArgv: string[];
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  homedir: () => string;
  cwd?: () => string;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  spawnSyncImpl?: typeof spawnSync;
  ensureGuardianDaemon?: () => Promise<void>;
  registerGuardianProcess?: (registration: GuardianRegistration) => Promise<void>;
  reportGuardianLifecycle?: (event: GuardianLifecycleEvent) => Promise<boolean>;
  getModulesConfigPath: () => string;
  resolveCliEntryPath?: () => string;
  resolveServerEntryPath: () => string;
  waitForever: () => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, cb: () => void) => void;
  exit: (code: number) => never;
};

export type LauncherCommandOptions = {
  port?: string;
  host: string;
  url?: string;
  config?: string;
  apikey?: string;
  cwd?: string;
  model?: string;
  profile?: string;
  ensureServer?: boolean;
  [key: string]: unknown;
};

export type LauncherSpec = {
  commandName: string;
  displayName: string;
  description: string;
  allowAutoStartServer?: boolean;
  binaryOptionFlags: string;
  binaryOptionName: string;
  binaryOptionDescription: string;
  binaryDefault: string;
  binaryEnvKey?: string;
  extraKnownOptions: string[];
  withModelOption?: boolean;
  withProfileOption?: boolean;
  buildArgs: (options: LauncherCommandOptions) => string[];
  buildEnv: (args: {
    env: NodeJS.ProcessEnv;
    baseUrl: string;
    configuredApiKey: string | null;
    cwd: string;
  }) => NodeJS.ProcessEnv;
};

export type ResolvedServerConnection = {
  configPath: string;
  protocol: 'http' | 'https';
  host: string;
  connectHost: string;
  port: number;
  basePath: string;
  portPart: string;
  serverUrl: string;
  configuredApiKey: string | null;
};

export type ClockClientService = {
  daemonId: string;
  tmuxSessionId: string;
  tmuxTarget?: string;
  syncHeartbeat: () => Promise<boolean>;
  stop: () => Promise<void>;
};

export type ManagedTmuxSession = {
  sessionName: string;
  tmuxTarget: string;
  reused: boolean;
  stop: () => void;
};

export type TmuxSelfHealPolicy = {
  enabled: boolean;
  maxRetries: number;
  retryDelaySec: number;
};

export type EnvDiff = {
  set: Array<[string, string]>;
  unset: string[];
};
