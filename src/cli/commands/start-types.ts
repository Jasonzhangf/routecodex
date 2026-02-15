import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

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

export type StartCommandOptions = {
  config?: string;
  port?: string;
  mode?: string;
  quotaRouting?: unknown;
  logLevel?: string;
  codex?: boolean;
  claude?: boolean;
  ua?: string;
  snap?: boolean;
  snapOff?: boolean;
  verboseErrors?: boolean;
  quietErrors?: boolean;
  restart?: boolean;
  exclusive?: boolean;
};

export type StartCommandContext = {
  isDevPackage: boolean;
  isWindows: boolean;
  defaultDevPort: number;
  nodeBin: string;
  createSpinner: (text: string) => Promise<Spinner>;
  logger: LoggerLike;
  env: NodeJS.ProcessEnv;
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  homedir?: () => string;
  tmpdir?: () => string;
  sleep: (ms: number) => Promise<void>;
  ensureLocalTokenPortalEnv: () => Promise<unknown>;
  ensureTokenDaemonAutoStart: () => Promise<void>;
  stopTokenDaemonIfRunning?: () => Promise<void>;
  ensurePortAvailable: (port: number, spinner: Spinner, opts?: { restart?: boolean }) => Promise<void>;
  findListeningPids: (port: number) => number[];
  killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
  getModulesConfigPath: () => string;
  resolveCliEntryPath?: () => string;
  resolveServerEntryPath: () => string;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch: typeof fetch;
  setupKeypress: (onInterrupt: () => void) => () => void;
  waitForever: () => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, cb: () => void) => void;
  exit: (code: number) => never;
};
