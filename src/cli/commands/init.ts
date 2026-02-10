import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Command } from 'commander';

import { getInitProviderCatalog, type InitProviderTemplate } from '../config/init-provider-catalog.js';
import { parseProvidersArg } from '../config/init-config.js';
import { installBundledDocsBestEffort } from '../config/bundled-docs.js';

type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

type UnknownRecord = Record<string, unknown>;

type RoutingConfig = Record<string, unknown>;

type ProviderV2Payload = {
  version: string;
  providerId: string;
  provider: UnknownRecord;
};

type DuplicateProviderResolution = 'keep' | 'overwrite' | 'merge';

type PromptLike = (question: string) => Promise<string>;

type ConfigState =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'v1'; data: UnknownRecord }
  | { kind: 'v2'; data: UnknownRecord };

export type InitCommandContext = {
  logger: LoggerLike;
  createSpinner: (text: string) => Promise<Spinner>;
  getHomeDir?: () => string;
  fsImpl?: typeof fs;
  pathImpl?: typeof path;
  prompt?: (question: string) => Promise<string>;
};

type InitCommandOptions = {
  config?: string;
  force?: boolean;
  providers?: string;
  defaultProvider?: string;
  host?: string;
  port?: string;
  listProviders?: boolean;
};

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function normalizeHost(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = String(input).trim();
  return trimmed ? trimmed : undefined;
}

function normalizePort(input: string | number | undefined): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function buildInteractivePrompt(
  ctx: InitCommandContext
): { prompt: PromptLike; close: () => void } | null {
  if (typeof ctx.prompt === 'function') {
    return { prompt: ctx.prompt, close: () => {} };
  }
  if (process.env.CI === '1' || process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    return null;
  }
  if (!input.isTTY || !output.isTTY) {
    return null;
  }
  const rl = readline.createInterface({ input, output });
  return {
    prompt: async (question: string) => rl.question(question),
    close: () => rl.close()
  };
}

function getProviderRoot(pathImpl: typeof path, homeDir: string): string {
  return pathImpl.join(homeDir, '.routecodex', 'provider');
}

function getProviderV2Path(pathImpl: typeof path, providerRoot: string, providerId: string): string {
  return pathImpl.join(providerRoot, providerId, 'config.v2.json');
}

function inferDefaultModel(providerNode: UnknownRecord): string {
  const models = asRecord(providerNode.models);
  const keys = Object.keys(models);
  if (keys.length > 0) {
    return keys[0];
  }
  return 'gpt-4o-mini';
}

function buildRouting(defaultTarget: string, overrides?: Partial<Record<'default' | 'thinking' | 'tools', string>>): RoutingConfig {
  const targetDefault = overrides?.default || defaultTarget;
  const targetThinking = overrides?.thinking || targetDefault;
  const targetTools = overrides?.tools || targetDefault;
  return {
    default: [{ id: 'primary', mode: 'priority', targets: [targetDefault] }],
    thinking: [{ id: 'thinking-primary', mode: 'priority', targets: [targetThinking] }],
    tools: [{ id: 'tools-primary', mode: 'priority', targets: [targetTools] }]
  };
}

function readPrimaryTargetFromRoute(routeNode: unknown): string | null {
  if (!Array.isArray(routeNode) || routeNode.length === 0) {
    return null;
  }
  const firstPool = asRecord(routeNode[0]);
  const targets = Array.isArray(firstPool.targets) ? firstPool.targets : [];
  const firstTarget = targets.find((target) => typeof target === 'string' && target.trim());
  return typeof firstTarget === 'string' ? firstTarget.trim() : null;
}

function readRoutingFromConfig(config: UnknownRecord): RoutingConfig {
  const virtualRouter = asRecord(config.virtualrouter);
  const vrRouting = asRecord(virtualRouter.routing);
  if (Object.keys(vrRouting).length > 0) {
    return vrRouting;
  }
  const rootRouting = asRecord(config.routing);
  return rootRouting;
}

function readProvidersFromV1(config: UnknownRecord): Record<string, UnknownRecord> {
  const virtualRouter = asRecord(config.virtualrouter);
  const fromVirtualRouter = asRecord(virtualRouter.providers);
  if (Object.keys(fromVirtualRouter).length > 0) {
    const normalized: Record<string, UnknownRecord> = {};
    for (const [providerId, providerNode] of Object.entries(fromVirtualRouter)) {
      if (isRecord(providerNode)) {
        normalized[providerId] = providerNode;
      }
    }
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  const fromRoot = asRecord(config.providers);
  const rootNormalized: Record<string, UnknownRecord> = {};
  for (const [providerId, providerNode] of Object.entries(fromRoot)) {
    if (isRecord(providerNode)) {
      rootNormalized[providerId] = providerNode;
    }
  }
  return rootNormalized;
}

function inspectConfigState(fsImpl: typeof fs, configPath: string): ConfigState {
  if (!fsImpl.existsSync(configPath)) {
    return { kind: 'missing' };
  }
  try {
    const raw = fsImpl.readFileSync(configPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!isRecord(parsed)) {
      return { kind: 'invalid', message: 'Config root must be a JSON object' };
    }
    const mode = typeof parsed.virtualrouterMode === 'string' ? parsed.virtualrouterMode.trim().toLowerCase() : '';
    if (mode === 'v2') {
      return { kind: 'v2', data: parsed };
    }
    return { kind: 'v1', data: parsed };
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
}

function ensureDir(fsImpl: typeof fs, dirPath: string): void {
  if (!fsImpl.existsSync(dirPath)) {
    fsImpl.mkdirSync(dirPath, { recursive: true });
  }
}

function mergeRecordsPreferExisting(baseFromV1: UnknownRecord, existing: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = { ...baseFromV1 };
  for (const [key, existingValue] of Object.entries(existing)) {
    const baseValue = result[key];
    if (Array.isArray(existingValue)) {
      result[key] = existingValue.length ? existingValue : baseValue;
      continue;
    }
    if (isRecord(existingValue) && isRecord(baseValue)) {
      result[key] = mergeRecordsPreferExisting(baseValue, existingValue);
      continue;
    }
    result[key] = existingValue;
  }
  return result;
}

function readProviderV2Payload(
  fsImpl: typeof fs,
  filePath: string
): ProviderV2Payload | null {
  try {
    if (!fsImpl.existsSync(filePath)) {
      return null;
    }
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!isRecord(parsed)) {
      return null;
    }
    const providerIdRaw = parsed.providerId;
    const providerNode = parsed.provider;
    if (typeof providerIdRaw !== 'string' || !providerIdRaw.trim() || !isRecord(providerNode)) {
      return null;
    }
    const versionRaw = parsed.version;
    const version = typeof versionRaw === 'string' && versionRaw.trim() ? versionRaw.trim() : '2.0.0';
    return {
      version,
      providerId: providerIdRaw.trim(),
      provider: providerNode
    };
  } catch {
    return null;
  }
}

function backupFileBestEffort(fsImpl: typeof fs, filePath: string): string | null {
  try {
    if (!fsImpl.existsSync(filePath)) {
      return null;
    }
    const backupPath = computeBackupPath(fsImpl, filePath);
    fsImpl.writeFileSync(backupPath, fsImpl.readFileSync(filePath, 'utf8'), 'utf8');
    return backupPath;
  } catch {
    return null;
  }
}

async function promptDuplicateProviderResolution(
  prompt: PromptLike,
  providerId: string
): Promise<DuplicateProviderResolution> {
  while (true) {
    const answer = (await prompt(
      `Provider "${providerId}" already exists in v2 provider root. Choose: (k)eep / (o)verwrite / (m)erge (default=k)\n> `
    ))
      .trim()
      .toLowerCase();

    if (!answer || answer === 'k' || answer === 'keep') {
      return 'keep';
    }
    if (answer === 'o' || answer === 'overwrite') {
      return 'overwrite';
    }
    if (answer === 'm' || answer === 'merge') {
      return 'merge';
    }
  }
}

function computeBackupPath(fsImpl: typeof fs, filePath: string): string {
  const base = `${filePath}.bak`;
  if (!fsImpl.existsSync(base)) {
    return base;
  }
  for (let index = 1; index < 10000; index++) {
    const candidate = `${base}.${index}`;
    if (!fsImpl.existsSync(candidate)) {
      return candidate;
    }
  }
  return `${base}.${Date.now()}`;
}

function writeJsonFile(fsImpl: typeof fs, filePath: string, payload: unknown): void {
  fsImpl.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function writeProviderV2(
  fsImpl: typeof fs,
  pathImpl: typeof path,
  providerRoot: string,
  providerId: string,
  providerNode: UnknownRecord
): string {
  const providerDir = pathImpl.join(providerRoot, providerId);
  ensureDir(fsImpl, providerDir);
  const filePath = getProviderV2Path(pathImpl, providerRoot, providerId);
  const payload: ProviderV2Payload = {
    version: '2.0.0',
    providerId,
    provider: providerNode
  };
  writeJsonFile(fsImpl, filePath, payload);
  return filePath;
}

function loadProviderV2Map(fsImpl: typeof fs, pathImpl: typeof path, providerRoot: string): Record<string, ProviderV2Payload> {
  const result: Record<string, ProviderV2Payload> = {};
  if (!fsImpl.existsSync(providerRoot)) {
    return result;
  }

  const entries = fsImpl.readdirSync(providerRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const filePath = getProviderV2Path(pathImpl, providerRoot, entry.name);
    if (!fsImpl.existsSync(filePath)) {
      continue;
    }
    try {
      const raw = fsImpl.readFileSync(filePath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!isRecord(parsed)) {
        continue;
      }
      const providerId = typeof parsed.providerId === 'string' ? parsed.providerId.trim() : '';
      const providerNode = asRecord(parsed.provider);
      if (!providerId || !Object.keys(providerNode).length) {
        continue;
      }
      result[providerId] = {
        version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '2.0.0',
        providerId,
        provider: providerNode
      };
    } catch {
      // ignore malformed files
    }
  }
  return result;
}

async function promptYesNo(prompt: PromptLike, question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await prompt(`${question} (${suffix})\n> `)).trim().toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  if (answer === 'y' || answer === 'yes') {
    return true;
  }
  if (answer === 'n' || answer === 'no') {
    return false;
  }
  return defaultYes;
}

async function interactiveSelectProviders(
  prompt: PromptLike,
  catalog: InitProviderTemplate[]
): Promise<InitProviderTemplate[]> {
  const selected = new Set<string>();
  while (true) {
    const lines = catalog.map((provider, index) => {
      const mark = selected.has(provider.id) ? '[x]' : '[ ]';
      return `  ${index + 1}) ${mark} ${provider.id} - ${provider.label}`;
    });
    const answer = (await prompt(
      `Select providers one-by-one: number toggles selection, 'd' to finish.\n${lines.join('\n')}\n> `
    ))
      .trim()
      .toLowerCase();

    if (!answer) {
      if (!selected.size) {
        selected.add(catalog[0].id);
      }
      break;
    }
    if (answer === 'd' || answer === 'done') {
      if (!selected.size) {
        continue;
      }
      break;
    }

    const number = Number(answer);
    if (!Number.isFinite(number)) {
      continue;
    }
    const index = Math.floor(number) - 1;
    if (index < 0 || index >= catalog.length) {
      continue;
    }
    const providerId = catalog[index].id;
    if (selected.has(providerId)) {
      selected.delete(providerId);
    } else {
      selected.add(providerId);
    }
  }

  return catalog.filter((provider) => selected.has(provider.id));
}

async function interactivePickDefaultProvider(
  prompt: PromptLike,
  selectedProviders: InitProviderTemplate[]
): Promise<string> {
  if (selectedProviders.length === 1) {
    return selectedProviders[0].id;
  }

  const lines = selectedProviders.map((provider, index) => `  ${index + 1}) ${provider.id} - ${provider.label}`);
  const answer = (await prompt(`Select default provider for routing.default (default=1)\n${lines.join('\n')}\n> `)).trim();
  const number = Number(answer);
  if (Number.isFinite(number) && number > 0 && Math.floor(number) <= selectedProviders.length) {
    return selectedProviders[Math.floor(number) - 1].id;
  }
  return selectedProviders[0].id;
}

async function interactiveHostPort(
  prompt: PromptLike,
  defaults: { host: string; port: number }
): Promise<{ host: string; port: number }> {
  const hostAnswer = await prompt(`Server host (default=${defaults.host})\n> `);
  const portAnswer = await prompt(`Server port (default=${defaults.port})\n> `);
  return {
    host: normalizeHost(hostAnswer) ?? defaults.host,
    port: normalizePort(portAnswer) ?? defaults.port
  };
}

function isValidTargetFormat(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) {
    return false;
  }
  const dotIndex = trimmed.indexOf('.');
  return dotIndex > 0 && dotIndex < trimmed.length - 1;
}

async function interactiveRoutingWizard(
  prompt: PromptLike,
  existingRouting: RoutingConfig,
  defaultTarget: string
): Promise<RoutingConfig> {
  const keys: Array<'default' | 'thinking' | 'tools'> = ['default', 'thinking', 'tools'];
  const targets: Record<'default' | 'thinking' | 'tools', string> = {
    default: readPrimaryTargetFromRoute(existingRouting.default) || defaultTarget,
    thinking: readPrimaryTargetFromRoute(existingRouting.thinking) || readPrimaryTargetFromRoute(existingRouting.default) || defaultTarget,
    tools: readPrimaryTargetFromRoute(existingRouting.tools) || readPrimaryTargetFromRoute(existingRouting.default) || defaultTarget
  };

  let index = 0;
  while (index < keys.length) {
    const key = keys[index];
    const answer = (await prompt(
      `Route [${key}] target (provider.model). Current=${targets[key]}\nUse: Enter=keep, b=back, s=skip\n> `
    ))
      .trim();

    if (answer.toLowerCase() === 'b') {
      if (index > 0) {
        index -= 1;
      }
      continue;
    }
    if (answer.toLowerCase() === 's' || !answer) {
      index += 1;
      continue;
    }
    if (!isValidTargetFormat(answer)) {
      continue;
    }
    targets[key] = answer;
    index += 1;
  }

  while (true) {
    const summary = keys.map((key) => `${key}=${targets[key]}`).join(', ');
    const answer = (await prompt(`Routing summary: ${summary}\nType route key to edit or 'save' to continue\n> `))
      .trim()
      .toLowerCase();
    if (!answer || answer === 'save') {
      break;
    }
    if ((keys as string[]).includes(answer)) {
      const key = answer as 'default' | 'thinking' | 'tools';
      const edit = (await prompt(`New target for ${key} (provider.model), current=${targets[key]}\n> `)).trim();
      if (isValidTargetFormat(edit)) {
        targets[key] = edit;
      }
    }
  }

  return buildRouting(defaultTarget, {
    default: targets.default,
    thinking: targets.thinking,
    tools: targets.tools
  });
}

function resolveSelectedTemplates(
  providerIds: string[],
  catalogById: Map<string, InitProviderTemplate>
): InitProviderTemplate[] {
  const selected: InitProviderTemplate[] = [];
  for (const providerId of providerIds) {
    const template = catalogById.get(providerId);
    if (template) {
      selected.push(template);
    }
  }
  return selected;
}

function ensureTargetProvidersExist(routing: RoutingConfig, providerIds: Set<string>): string[] {
  const missing: string[] = [];
  for (const routeNode of Object.values(routing)) {
    if (!Array.isArray(routeNode)) {
      continue;
    }
    for (const poolNode of routeNode) {
      const pool = asRecord(poolNode);
      const targets = Array.isArray(pool.targets) ? pool.targets : [];
      for (const target of targets) {
        if (typeof target !== 'string' || !target.trim()) {
          continue;
        }
        const providerId = target.split('.', 1)[0];
        if (!providerIds.has(providerId)) {
          missing.push(target);
        }
      }
    }
  }
  return missing;
}

function buildV2ConfigFromExisting(
  existing: UnknownRecord,
  routing: RoutingConfig,
  host: string,
  port: number
): UnknownRecord {
  const next: UnknownRecord = {
    ...existing,
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      ...asRecord(existing.httpserver),
      host,
      port
    }
  };

  const virtualRouter = asRecord(existing.virtualrouter);
  delete virtualRouter.providers;
  virtualRouter.routing = routing;
  next.virtualrouter = virtualRouter;
  delete next.providers;
  delete next.routing;
  return next;
}

async function migrateV1ToV2(args: {
  fsImpl: typeof fs;
  pathImpl: typeof path;
  configPath: string;
  providerRoot: string;
  v1Config: UnknownRecord;
  spinner: Spinner;
  logger: LoggerLike;
  prompt?: PromptLike;
  forceOverwriteProviders?: boolean;
}): Promise<{ convertedProviders: string[]; backupPath: string | null }> {
  const {
    fsImpl,
    pathImpl,
    configPath,
    providerRoot,
    v1Config,
    spinner,
    logger,
    prompt,
    forceOverwriteProviders
  } = args;
  const providers = readProvidersFromV1(v1Config);
  const providerEntries = Object.entries(providers);
  if (!providerEntries.length) {
    throw new Error('No providers found in v1 config, cannot migrate automatically');
  }

  ensureDir(fsImpl, providerRoot);

  const resolutions = new Map<string, DuplicateProviderResolution>();
  for (const [providerId] of providerEntries) {
    const v2Path = getProviderV2Path(pathImpl, providerRoot, providerId);
    if (!fsImpl.existsSync(v2Path)) {
      continue;
    }
    if (forceOverwriteProviders) {
      resolutions.set(providerId, 'overwrite');
      continue;
    }
    if (prompt) {
      resolutions.set(providerId, await promptDuplicateProviderResolution(prompt, providerId));
      continue;
    }
    resolutions.set(providerId, 'keep');
    logger.info(`Provider ${providerId} already exists; keeping existing config.v2.json (non-interactive mode)`);
  }

  const convertedProviders: string[] = [];
  for (const [providerId, providerNode] of providerEntries) {
    const resolution = resolutions.get(providerId) ?? 'overwrite';
    if (resolution === 'keep') {
      continue;
    }

    const v2Path = getProviderV2Path(pathImpl, providerRoot, providerId);
    if (resolution === 'merge') {
      const existingPayload = readProviderV2Payload(fsImpl, v2Path);
      if (existingPayload) {
        backupFileBestEffort(fsImpl, v2Path);
        const mergedProvider = mergeRecordsPreferExisting(providerNode, existingPayload.provider);
        writeProviderV2(fsImpl, pathImpl, providerRoot, providerId, mergedProvider);
        convertedProviders.push(providerId);
        continue;
      }
      // fall through to overwrite when existing payload cannot be parsed.
    }

    if (fsImpl.existsSync(v2Path)) {
      backupFileBestEffort(fsImpl, v2Path);
    }
    writeProviderV2(fsImpl, pathImpl, providerRoot, providerId, providerNode);
    convertedProviders.push(providerId);
  }

  const firstProvider = providerEntries[0];
  const defaultTarget = `${firstProvider[0]}.${inferDefaultModel(firstProvider[1])}`;
  const routing = readRoutingFromConfig(v1Config);
  const normalizedRouting = Object.keys(routing).length ? routing : buildRouting(defaultTarget);

  const hostFromConfig = normalizeHost(String(v1Config?.httpserver && (v1Config.httpserver as any).host || v1Config?.host || '')) || '127.0.0.1';
  const portFromConfig =
    normalizePort((v1Config?.httpserver && (v1Config.httpserver as any).port) as number | string | undefined) ||
    normalizePort(v1Config?.port as number | string | undefined) ||
    5555;

  const nextConfig = buildV2ConfigFromExisting(v1Config, normalizedRouting, hostFromConfig, portFromConfig);

  let backupPath: string | null = null;
  if (fsImpl.existsSync(configPath)) {
    backupPath = computeBackupPath(fsImpl, configPath);
    fsImpl.writeFileSync(backupPath, fsImpl.readFileSync(configPath, 'utf8'), 'utf8');
  }

  writeJsonFile(fsImpl, configPath, nextConfig);
  spinner.info(`Migrated providers to: ${providerRoot}`);
  return { convertedProviders, backupPath };
}

async function runV2MaintenanceMenu(args: {
  prompt: PromptLike;
  fsImpl: typeof fs;
  pathImpl: typeof path;
  configPath: string;
  providerRoot: string;
  config: UnknownRecord;
  catalog: InitProviderTemplate[];
  spinner: Spinner;
  logger: LoggerLike;
}): Promise<void> {
  const { prompt, fsImpl, pathImpl, configPath, providerRoot, catalog, spinner, logger } = args;

  let currentConfig = args.config;
  ensureDir(fsImpl, providerRoot);

  const catalogById = new Map(catalog.map((provider) => [provider.id, provider]));

  while (true) {
    const providerMap = loadProviderV2Map(fsImpl, pathImpl, providerRoot);
    const providerIds = Object.keys(providerMap).sort();

    const answer = (await prompt(
      `V2 config menu:\n` +
      `  1) Add provider\n` +
      `  2) Delete provider\n` +
      `  3) Modify provider\n` +
      `  4) Modify routing\n` +
      `  5) Save and exit\n` +
      `  6) Exit without changes\n> `
    ))
      .trim();

    if (answer === '1') {
      const addable = catalog.filter((provider) => !providerIds.includes(provider.id));
      if (!addable.length) {
        logger.info('No remaining built-in providers to add.');
        continue;
      }
      const lines = addable.map((provider, index) => `  ${index + 1}) ${provider.id} - ${provider.label}`);
      const pick = (await prompt(`Choose provider to add:\n${lines.join('\n')}\n> `)).trim();
      const index = Number(pick);
      if (!Number.isFinite(index) || index <= 0 || Math.floor(index) > addable.length) {
        continue;
      }
      const selected = addable[Math.floor(index) - 1];
      writeProviderV2(fsImpl, pathImpl, providerRoot, selected.id, asRecord(selected.provider));
      logger.info(`Added provider: ${selected.id}`);
      continue;
    }

    if (answer === '2') {
      if (!providerIds.length) {
        logger.info('No providers to delete.');
        continue;
      }
      const lines = providerIds.map((providerId, index) => `  ${index + 1}) ${providerId}`);
      const pick = (await prompt(`Choose provider to delete:\n${lines.join('\n')}\n> `)).trim();
      const index = Number(pick);
      if (!Number.isFinite(index) || index <= 0 || Math.floor(index) > providerIds.length) {
        continue;
      }
      const providerId = providerIds[Math.floor(index) - 1];
      const confirmed = await promptYesNo(prompt, `Delete provider ${providerId}?`, false);
      if (!confirmed) {
        continue;
      }
      const filePath = getProviderV2Path(pathImpl, providerRoot, providerId);
      if (fsImpl.existsSync(filePath)) {
        fsImpl.unlinkSync(filePath);
      }
      const providerDir = pathImpl.join(providerRoot, providerId);
      try {
        fsImpl.rmdirSync(providerDir);
      } catch {
        // ignore non-empty directories
      }
      logger.info(`Deleted provider: ${providerId}`);
      continue;
    }

    if (answer === '3') {
      if (!providerIds.length) {
        logger.info('No providers to modify.');
        continue;
      }
      const lines = providerIds.map((providerId, index) => `  ${index + 1}) ${providerId}`);
      const pick = (await prompt(`Choose provider to modify:\n${lines.join('\n')}\n> `)).trim();
      const index = Number(pick);
      if (!Number.isFinite(index) || index <= 0 || Math.floor(index) > providerIds.length) {
        continue;
      }
      const providerId = providerIds[Math.floor(index) - 1];
      const payload = providerMap[providerId];
      if (!payload) {
        continue;
      }

      const providerNode = { ...payload.provider };

      while (true) {
        const enabled = providerNode.enabled === false ? 'false' : 'true';
        const baseUrl = typeof providerNode.baseURL === 'string' ? providerNode.baseURL : '(unset)';
        const action = (await prompt(
          `Modify ${providerId}: enabled=${enabled}, baseURL=${baseUrl}\n` +
          `  1) Toggle enabled\n` +
          `  2) Set baseURL\n` +
          `  3) Replace with catalog template\n` +
          `  4) Save provider\n> `
        ))
          .trim();

        if (action === '1') {
          providerNode.enabled = providerNode.enabled === false;
          continue;
        }
        if (action === '2') {
          const nextBase = (await prompt('New baseURL:\n> ')).trim();
          if (nextBase) {
            providerNode.baseURL = nextBase;
          }
          continue;
        }
        if (action === '3') {
          const template = catalogById.get(providerId);
          if (!template) {
            logger.info(`No built-in template for provider ${providerId}`);
            continue;
          }
          Object.assign(providerNode, asRecord(template.provider));
          continue;
        }
        if (action === '4') {
          writeProviderV2(fsImpl, pathImpl, providerRoot, providerId, providerNode);
          logger.info(`Saved provider: ${providerId}`);
          break;
        }
      }
      continue;
    }

    if (answer === '4') {
      const routing = readRoutingFromConfig(currentConfig);
      const fallbackProviderId = providerIds[0] || 'openai';
      const fallbackModel = providerMap[fallbackProviderId]
        ? inferDefaultModel(providerMap[fallbackProviderId].provider)
        : 'gpt-4o-mini';
      const fallbackTarget = `${fallbackProviderId}.${fallbackModel}`;
      const nextRouting = await interactiveRoutingWizard(prompt, routing, fallbackTarget);
      const host = normalizeHost(String(asRecord(currentConfig.httpserver).host || '')) || '127.0.0.1';
      const port = normalizePort(asRecord(currentConfig.httpserver).port as string | number | undefined) || 5555;
      currentConfig = buildV2ConfigFromExisting(currentConfig, nextRouting, host, port);
      continue;
    }

    if (answer === '5') {
      const providerIdsSet = new Set(Object.keys(loadProviderV2Map(fsImpl, pathImpl, providerRoot)));
      const routing = readRoutingFromConfig(currentConfig);
      const missingTargets = ensureTargetProvidersExist(routing, providerIdsSet);
      if (missingTargets.length) {
        spinner.warn(`Routing has targets for missing providers: ${missingTargets.join(', ')}`);
        continue;
      }
      writeJsonFile(fsImpl, configPath, currentConfig);
      spinner.succeed(`Configuration updated: ${configPath}`);
      return;
    }

    if (answer === '6') {
      spinner.info('Exit without saving changes to main config.');
      return;
    }
  }
}

export function createInitCommand(program: Command, ctx: InitCommandContext): void {
  const fsImpl = (ctx.fsImpl ?? fs) as typeof fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const bin = typeof (program as unknown as { name?: () => string }).name === 'function' ? program.name() : 'rcc';

  program
    .command('init')
    .description('Initialize ~/.routecodex/config.json (V2 guided setup and maintenance)')
    .addHelpText(
      'after',
      `
Examples:
  ${bin} init
  ${bin} init --list-providers
  ${bin} init --providers openai,tab --default-provider tab
`
    )
    .option('-c, --config <config>', 'Configuration file path')
    .option('-f, --force', 'Force overwrite existing configuration during fresh setup')
    .option('--providers <ids>', 'Providers (comma-separated), e.g. openai,tab,glm')
    .option('--default-provider <id>', 'Default provider id for routing.default')
    .option('--host <host>', 'Server host (httpserver.host)')
    .option('--port <port>', 'Server port (httpserver.port)')
    .option('--list-providers', 'List built-in provider ids and exit')
    .action(async (options: InitCommandOptions) => {
      const spinner = await ctx.createSpinner('Initializing configuration...');

      const safeSpinnerStop = () => {
        try {
          spinner.stop();
        } catch {
          // ignore
        }
      };

      const safeSpinnerStart = (text: string) => {
        try {
          spinner.start(text);
        } catch {
          // ignore
        }
      };

      const configPath = options.config || pathImpl.join(home(), '.routecodex', 'config.json');
      const providerRoot = getProviderRoot(pathImpl, home());

      const catalog = getInitProviderCatalog();
      const catalogById = new Map(catalog.map((provider) => [provider.id, provider]));
      const supported = catalog.map((provider) => provider.id).join(', ');

      if (options.listProviders) {
        spinner.stop();
        for (const entry of catalog) {
          ctx.logger.info(`${entry.id} - ${entry.label}: ${entry.description}`);
        }
        return;
      }

      const providersFromArg = parseProvidersArg(options.providers);
      const promptBundle = buildInteractivePrompt(ctx);

      try {
        const state = inspectConfigState(fsImpl, configPath);
        if (state.kind === 'invalid') {
          spinner.fail('Failed to initialize configuration');
          ctx.logger.error(`Invalid JSON in configuration file: ${state.message}`);
          return;
        }

        if (state.kind === 'missing') {
          let selectedTemplates: InitProviderTemplate[] = [];

          if (providersFromArg && providersFromArg.length) {
            selectedTemplates = resolveSelectedTemplates(providersFromArg, catalogById);
            if (!selectedTemplates.length) {
              spinner.fail('Failed to initialize configuration');
              ctx.logger.error(`No valid provider ids found. Supported: ${supported}`);
              return;
            }
          } else if (promptBundle) {
            safeSpinnerStop();
            selectedTemplates = await interactiveSelectProviders(promptBundle.prompt, catalog);
          } else {
            spinner.fail('Failed to initialize configuration');
            ctx.logger.error(`Non-interactive init requires --providers. Supported: ${supported}`);
            return;
          }

          const selectedProviderIds = selectedTemplates.map((provider) => provider.id);
          let defaultProviderId = options.defaultProvider;
          if (defaultProviderId && !selectedProviderIds.includes(defaultProviderId)) {
            spinner.fail('Failed to initialize configuration');
            ctx.logger.error(
              `defaultProvider "${defaultProviderId}" is not in selected providers: ${selectedProviderIds.join(', ')}`
            );
            return;
          }

          if (!defaultProviderId) {
            if (promptBundle) {
              safeSpinnerStop();
              defaultProviderId = await interactivePickDefaultProvider(promptBundle.prompt, selectedTemplates);
            } else {
              defaultProviderId = selectedTemplates[0].id;
            }
          }

          const defaultTemplate = selectedTemplates.find((provider) => provider.id === defaultProviderId) || selectedTemplates[0];
          const defaultTarget = `${defaultTemplate.id}.${defaultTemplate.defaultModel}`;

          const defaultHost = normalizeHost(options.host) || '127.0.0.1';
          const defaultPort = normalizePort(options.port) || 5555;

          let host = defaultHost;
          let port = defaultPort;
          if (promptBundle && options.host === undefined && options.port === undefined) {
            safeSpinnerStop();
            const hp = await interactiveHostPort(promptBundle.prompt, { host, port });
            host = hp.host;
            port = hp.port;
          }

          const baseRouting = buildRouting(defaultTarget);
          const routing = promptBundle
            ? (safeSpinnerStop(), await interactiveRoutingWizard(promptBundle.prompt, baseRouting, defaultTarget))
            : baseRouting;

          if (fsImpl.existsSync(configPath) && !options.force) {
            spinner.fail('Failed to initialize configuration');
            ctx.logger.error(`Configuration file already exists: ${configPath}`);
            return;
          }

          ensureDir(fsImpl, pathImpl.dirname(configPath));
          ensureDir(fsImpl, providerRoot);

          let backupPath: string | null = null;
          if (options.force && fsImpl.existsSync(configPath)) {
            backupPath = computeBackupPath(fsImpl, configPath);
            fsImpl.writeFileSync(backupPath, fsImpl.readFileSync(configPath, 'utf8'), 'utf8');
          }

          for (const template of selectedTemplates) {
            writeProviderV2(fsImpl, pathImpl, providerRoot, template.id, asRecord(template.provider));
          }

          const configPayload = buildV2ConfigFromExisting({}, routing, host, port);
          writeJsonFile(fsImpl, configPath, configPayload);

          spinner.succeed(`Configuration initialized: ${configPath}`);
          if (backupPath) {
            ctx.logger.info(`Backed up existing config: ${backupPath}`);
          }
          ctx.logger.info(`Providers: ${selectedProviderIds.join(', ')}`);
          ctx.logger.info(`Default provider: ${defaultProviderId}`);
          ctx.logger.info(`Provider root: ${providerRoot}`);
          const installed = installBundledDocsBestEffort({ fsImpl, pathImpl });
          if (installed.ok) {
            ctx.logger.info(`Docs installed: ${installed.targetDir}`);
          }
          ctx.logger.info('Next: edit auth credentials in provider/*.json, then run: rcc start');
          return;
        }

        if (state.kind === 'v1') {
          let doConvert = Boolean(options.force);
          if (promptBundle) {
            // Avoid spinner interfering with readline prompts.
            safeSpinnerStop();
            doConvert = await promptYesNo(promptBundle.prompt, 'Detected V1 config. Convert to V2 now?', true);
          }
          if (!doConvert) {
            spinner.info('Skipped V1 -> V2 conversion.');
            return;
          }

          safeSpinnerStart('Converting V1 -> V2...');

          const migrated = await migrateV1ToV2({
            fsImpl,
            pathImpl,
            configPath,
            providerRoot,
            v1Config: state.data,
            spinner,
            logger: ctx.logger,
            prompt: promptBundle?.prompt,
            forceOverwriteProviders: Boolean(options.force)
          });

          spinner.succeed(`Converted V1 -> V2: ${configPath}`);
          if (migrated.backupPath) {
            ctx.logger.info(`Backup saved: ${migrated.backupPath}`);
          }
          ctx.logger.info(`Migrated providers: ${migrated.convertedProviders.join(', ')}`);
          ctx.logger.info(`Provider root: ${providerRoot}`);

          if (promptBundle) {
            safeSpinnerStop();
            const maintainNow = await promptYesNo(promptBundle.prompt, 'Open V2 maintenance menu now?', true);
            if (maintainNow) {
              const refreshedState = inspectConfigState(fsImpl, configPath);
              if (refreshedState.kind === 'v2') {
                await runV2MaintenanceMenu({
                  prompt: promptBundle.prompt,
                  fsImpl,
                  pathImpl,
                  configPath,
                  providerRoot,
                  config: refreshedState.data,
                  catalog,
                  spinner,
                  logger: ctx.logger
                });
              }
            }
          }
          return;
        }

        if (state.kind === 'v2') {
          if (!promptBundle) {
            spinner.fail('Failed to initialize configuration');
            ctx.logger.error('V2 config maintenance is interactive. Re-run in TTY mode.');
            return;
          }

          safeSpinnerStop();
          await runV2MaintenanceMenu({
            prompt: promptBundle.prompt,
            fsImpl,
            pathImpl,
            configPath,
            providerRoot,
            config: state.data,
            catalog,
            spinner,
            logger: ctx.logger
          });
          return;
        }
      } catch (error) {
        spinner.fail('Failed to initialize configuration');
        ctx.logger.error(error instanceof Error ? error.message : String(error));
      } finally {
        try {
          promptBundle?.close();
        } catch {
          // ignore
        }
      }
    });
}
