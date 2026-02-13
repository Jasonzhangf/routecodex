import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

import type { InitProviderTemplate } from '../../config/init-provider-catalog.js';
import type {
  ConfigState,
  DuplicateMigrationStrategy,
  DuplicateProviderResolution,
  InitCommandContext,
  LoggerLike,
  PromptLike,
  ProviderV2Payload,
  RoutingConfig,
  UnknownRecord
} from './shared.js';

export function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

export function normalizeHost(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = String(input).trim();
  return trimmed ? trimmed : undefined;
}

export function normalizePort(input: string | number | undefined): number | undefined {
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

export function buildInteractivePrompt(
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
  const rl = readline.createInterface({ input, output, terminal: true });
  return {
    prompt: (question: string) =>
      new Promise((resolve) => {
        let settled = false;
        const onClose = () => {
          if (settled) {
            return;
          }
          settled = true;
          rl.off('close', onClose);
          resolve('');
        };

        try {
          input.resume();
        } catch {
          // ignore
        }

        rl.once('close', onClose);
        rl.question(question, (answer) => {
          if (settled) {
            return;
          }
          settled = true;
          rl.off('close', onClose);
          resolve(answer);
        });
      }),
    close: () => rl.close()
  };
}

export function getProviderRoot(pathImpl: typeof path, homeDir: string): string {
  return pathImpl.join(homeDir, '.routecodex', 'provider');
}

export function getProviderV2Path(pathImpl: typeof path, providerRoot: string, providerId: string): string {
  return pathImpl.join(providerRoot, providerId, 'config.v2.json');
}

export function inferDefaultModel(providerNode: UnknownRecord): string {
  const models = asRecord(providerNode.models);
  const keys = Object.keys(models);
  if (keys.length > 0) {
    return keys[0];
  }
  return 'gpt-4o-mini';
}

export function buildRouting(defaultTarget: string, overrides?: Partial<Record<'default' | 'thinking' | 'tools', string>>): RoutingConfig {
  const targetDefault = overrides?.default || defaultTarget;
  const targetThinking = overrides?.thinking || targetDefault;
  const targetTools = overrides?.tools || targetDefault;
  return {
    default: [{ id: 'primary', mode: 'priority', targets: [targetDefault] }],
    thinking: [{ id: 'thinking-primary', mode: 'priority', targets: [targetThinking] }],
    tools: [{ id: 'tools-primary', mode: 'priority', targets: [targetTools] }]
  };
}

export function readPrimaryTargetFromRoute(routeNode: unknown): string | null {
  if (!Array.isArray(routeNode) || routeNode.length === 0) {
    return null;
  }
  const firstPool = asRecord(routeNode[0]);
  const targets = Array.isArray(firstPool.targets) ? firstPool.targets : [];
  const firstTarget = targets.find((target) => typeof target === 'string' && target.trim());
  return typeof firstTarget === 'string' ? firstTarget.trim() : null;
}

export function readRoutingFromConfig(config: UnknownRecord): RoutingConfig {
  const virtualRouter = asRecord(config.virtualrouter);
  const vrRouting = asRecord(virtualRouter.routing);
  if (Object.keys(vrRouting).length > 0) {
    return vrRouting;
  }
  const rootRouting = asRecord(config.routing);
  return rootRouting;
}

export function readProvidersFromV1(config: UnknownRecord): Record<string, UnknownRecord> {
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

export function inspectConfigState(fsImpl: typeof fs, configPath: string): ConfigState {
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

export function ensureDir(fsImpl: typeof fs, dirPath: string): void {
  if (!fsImpl.existsSync(dirPath)) {
    fsImpl.mkdirSync(dirPath, { recursive: true });
  }
}

export function mergeRecordsPreferExisting(baseFromV1: UnknownRecord, existing: UnknownRecord): UnknownRecord {
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

export function readProviderV2Payload(
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

export function backupFileBestEffort(fsImpl: typeof fs, filePath: string): string | null {
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

export async function promptDuplicateProviderResolution(
  prompt: PromptLike,
  providerId: string
): Promise<DuplicateProviderResolution> {
  while (true) {
    const answerRaw = await prompt(
      `Provider "${providerId}" already exists in v2 provider root. Choose: (k)eep / (o)verwrite / (m)erge (default=k)\n> `
    );
    const answer = String(answerRaw ?? '')
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

export async function promptDuplicateMigrationStrategy(
  prompt: PromptLike,
  duplicateProviderIds: string[]
): Promise<DuplicateMigrationStrategy> {
  const providersPreview = duplicateProviderIds.join(', ');
  while (true) {
    const answerRaw = await prompt(
      `Detected existing provider configs in provider dir: ${providersPreview}\n` +
      `Choose migration strategy: (a) overwrite all / (s) decide per-provider / (k) keep all (default=s)\n> `
    );
    const answer = String(answerRaw ?? '')
      .trim()
      .toLowerCase();

    if (!answer || answer === 's' || answer === 'split' || answer === 'per-provider' || answer === 'per_provider') {
      return 'per_provider';
    }
    if (answer === 'a' || answer === 'all' || answer === 'overwrite_all' || answer === 'overwrite-all') {
      return 'overwrite_all';
    }
    if (answer === 'k' || answer === 'keep' || answer === 'keep_all' || answer === 'keep-all') {
      return 'keep_all';
    }
  }
}

export function computeBackupPath(fsImpl: typeof fs, filePath: string): string {
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

export function writeJsonFile(fsImpl: typeof fs, filePath: string, payload: unknown): void {
  fsImpl.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export function writeProviderV2(
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

export function loadProviderV2Map(fsImpl: typeof fs, pathImpl: typeof path, providerRoot: string): Record<string, ProviderV2Payload> {
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

export function maskSecretTail3(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) {
    return '****';
  }
  const alphaNumTail = Array.from(value).filter((char) => /[A-Za-z0-9]/.test(char)).join('');
  const tail = (alphaNumTail || value).slice(-3);
  return `****${tail}`;
}

export function collectProviderKeyMasks(providerNode: UnknownRecord): string[] {
  const authNode = asRecord(providerNode.auth);
  const masks: string[] = [];
  const seen = new Set<string>();

  const addMasked = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const masked = maskSecretTail3(trimmed);
    if (seen.has(masked)) {
      return;
    }
    seen.add(masked);
    masks.push(masked);
  };

  addMasked(authNode.apiKey);
  addMasked(authNode.key);

  const keys = asRecord(authNode.keys);
  for (const value of Object.values(keys)) {
    addMasked(value);
  }

  return masks;
}

export function collectOauthTokenNames(providerNode: UnknownRecord): string[] {
  const authNode = asRecord(providerNode.auth);
  const authType = typeof authNode.type === 'string' ? authNode.type.trim().toLowerCase() : '';
  const looksOauth = authType.includes('oauth') || typeof authNode.tokenFile === 'string' || Array.isArray(authNode.entries);
  if (!looksOauth) {
    return [];
  }

  const labels: string[] = [];
  const seen = new Set<string>();
  const addLabel = (label: string) => {
    const normalized = label.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    labels.push(normalized);
  };

  const baseTokenFile = typeof authNode.tokenFile === 'string' ? authNode.tokenFile.trim() : '';
  if (baseTokenFile) {
    addLabel(path.basename(baseTokenFile));
  }

  const entries = Array.isArray(authNode.entries) ? authNode.entries : [];
  for (const entry of entries) {
    const node = asRecord(entry);
    const alias = typeof node.alias === 'string' ? node.alias.trim() : '';
    const tokenFile = typeof node.tokenFile === 'string' ? node.tokenFile.trim() : '';
    const tokenName = tokenFile ? path.basename(tokenFile) : '';

    if (alias && tokenName) {
      addLabel(`${alias}(${tokenName})`);
      continue;
    }
    if (alias) {
      addLabel(alias);
      continue;
    }
    if (tokenName) {
      addLabel(tokenName);
    }
  }

  return labels;
}

export function getProviderSummaryLine(providerId: string, payload: ProviderV2Payload): string {
  const providerNode = asRecord(payload.provider);
  const enabled = providerNode.enabled === false ? 'disabled' : 'enabled';
  const baseUrl = typeof providerNode.baseURL === 'string' && providerNode.baseURL.trim() ? providerNode.baseURL.trim() : '(unset)';
  const models = asRecord(providerNode.models);
  const modelCount = Object.keys(models).length;
  const keyMasks = collectProviderKeyMasks(providerNode);
  const oauthTokens = collectOauthTokenNames(providerNode);
  return (
    `${providerId} | ${enabled} | models=${modelCount} | ` +
    `keys=${keyMasks.length}${keyMasks.length ? ` [${keyMasks.join(', ')}]` : ''} | ` +
    `oauth=${oauthTokens.length ? oauthTokens.join(', ') : '-'} | baseURL=${baseUrl}`
  );
}

export function printConfiguredProviders(logger: LoggerLike, providerMap: Record<string, ProviderV2Payload>): void {
  const providerIds = Object.keys(providerMap).sort();
  if (!providerIds.length) {
    logger.info('No configured providers found in provider root.');
    return;
  }
  logger.info(`Configured providers (${providerIds.length}):`);
  for (const providerId of providerIds) {
    logger.info(`  - ${getProviderSummaryLine(providerId, providerMap[providerId])}`);
  }
}

export function normalizeEnvVarName(providerId: string): string {
  const normalized = providerId
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized ? `${normalized}_API_KEY` : 'PROVIDER_API_KEY';
}

export function isBackInput(value: string): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'b' || normalized === 'back' || normalized === '0';
}

export function resolveSelectedTemplates(
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

export function ensureTargetProvidersExist(routing: RoutingConfig, providerIds: Set<string>): string[] {
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

export function buildV2ConfigFromExisting(
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
