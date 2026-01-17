import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

import { updateProviderModels } from '../tools/provider-update/index.js';
import { fetchModelsFromUpstream } from '../tools/provider-update/fetch-models.js';
import { readBlacklist, writeBlacklist } from '../tools/provider-update/blacklist.js';
import { probeContextForModel } from '../tools/provider-update/probe-context.js';
import type { ProviderInputConfig } from '../tools/provider-update/types.js';
import { API_ENDPOINTS } from '../constants/index.js';
import { loadProviderConfigsV2, type ProviderConfigV2 } from '../config/provider-v2-loader.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';

function resolveProviderRoot(customRoot?: string): string {
  const trimmed = typeof customRoot === 'string' ? customRoot.trim() : '';
  if (trimmed) {
    return path.resolve(trimmed);
  }
  return path.join(os.homedir(), '.routecodex', 'provider');
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultValue && defaultValue.trim().length
    ? `${question} [${defaultValue}]: `
    : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const raw = String(answer || '').trim();
      resolve(raw || (defaultValue ?? ''));
    });
  });
}

function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}`, (answer) => {
      rl.close();
      const raw = String(answer || '').trim().toLowerCase();
      if (!raw) {
        resolve(defaultYes);
        return;
      }
      resolve(raw === 'y' || raw === 'yes');
    });
  });
}

function splitCsv(raw?: unknown): string[] {
  return typeof raw === 'string' && raw.trim()
    ? raw.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
}

function splitTokenThresholds(raw?: unknown): number[] {
  const parts = splitCsv(raw);
  const out: number[] = [];
  for (const part of parts) {
    const n = Math.floor(Number(part));
    if (Number.isFinite(n) && n > 0) {
      out.push(n);
    }
  }
  return out;
}

type ProviderUpdateAuth = {
  type: 'apikey' | 'oauth';
  apiKey?: string;
  headerName?: string;
  prefix?: string;
  tokenFile?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
};

type ProviderUpdateInput = {
  providerId: string;
  type: string;
  baseUrl?: string;
  baseURL?: string;
  auth?: ProviderUpdateAuth;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    const item = readString(entry);
    if (item) {
      out.push(item);
    }
  }
  return out.length ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractApiKeyFromAuthNode(authNode: Record<string, unknown>): string | undefined {
  const direct = readString(authNode.apiKey);
  if (direct) {
    return direct;
  }
  const keys = authNode.keys;
  if (!isRecord(keys)) {
    return undefined;
  }
  for (const entry of Object.values(keys)) {
    if (!isRecord(entry)) {
      continue;
    }
    const value = readString(entry.value);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeAuthForProviderUpdate(authNodeValue: unknown): ProviderUpdateAuth | undefined {
  if (!isRecord(authNodeValue)) {
    return undefined;
  }
  const authTypeRaw = readString(authNodeValue.type) ?? '';
  const authType = authTypeRaw.toLowerCase();

  if (authType.includes('oauth')) {
    return {
      type: 'oauth',
      tokenFile: readString(authNodeValue.tokenFile),
      clientId: readString(authNodeValue.clientId),
      clientSecret: readString(authNodeValue.clientSecret),
      tokenUrl: readString(authNodeValue.tokenUrl),
      deviceCodeUrl: readString(authNodeValue.deviceCodeUrl),
      scopes: readStringArray(authNodeValue.scopes)
    };
  }

  if (authType.includes('apikey') || authType === 'api_key' || authType === 'apikey') {
    return {
      type: 'apikey',
      apiKey: extractApiKeyFromAuthNode(authNodeValue),
      headerName: readString(authNodeValue.headerName),
      prefix: readString(authNodeValue.prefix)
    };
  }

  return undefined;
}

function buildProviderUpdateInputFromV2(providerId: string, provider: UnknownRecord): ProviderUpdateInput {
  const type = readString((provider as { type?: unknown }).type) ?? providerId;
  const baseURL = readString((provider as { baseURL?: unknown }).baseURL) ?? readString((provider as { baseUrl?: unknown }).baseUrl);
  const baseUrl = readString((provider as { baseUrl?: unknown }).baseUrl) ?? readString((provider as { baseURL?: unknown }).baseURL);
  const auth = normalizeAuthForProviderUpdate((provider as { auth?: unknown }).auth);
  return { providerId, type, baseURL, baseUrl, auth };
}

function normalizeModelsNode(node: unknown): Record<string, UnknownRecord> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return {};
  }
  return node as Record<string, UnknownRecord>;
}

type ProviderTemplateId =
  | 'glm'
  | 'qwen'
  | 'iflow'
  | 'kimi'
  | 'modelscope'
  | 'gemini-cli'
  | 'antigravity'
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'responses'
  | 'custom';

interface ProviderTemplate {
  id: ProviderTemplateId;
  label: string;
  providerTypeHint: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  defaultCompat?: string;
  defaultAuthType?: string;
}

const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'glm',
    label: 'GLM (Zhipu coding)',
    providerTypeHint: 'glm',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModel: 'glm-4.7',
    defaultCompat: 'chat:glm',
    defaultAuthType: 'apikey'
  },
  {
    id: 'qwen',
    label: 'Qwen Code (portal.qwen.ai)',
    providerTypeHint: 'qwen',
    defaultBaseUrl: 'https://portal.qwen.ai/v1',
    defaultModel: 'qwen3-coder-plus',
    defaultCompat: 'chat:qwen',
    defaultAuthType: 'qwen-oauth'
  },
  {
    id: 'iflow',
    label: 'iFlow aggregator',
    providerTypeHint: 'iflow',
    defaultBaseUrl: 'https://apis.iflow.cn/v1',
    defaultModel: 'kimi-k2',
    defaultCompat: 'chat:iflow',
    defaultAuthType: 'iflow-oauth'
  },
  {
    id: 'kimi',
    label: 'Kimi Coding',
    providerTypeHint: 'openai',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    defaultModel: 'kimi-for-coding',
    defaultAuthType: 'apikey'
  },
  {
    id: 'modelscope',
    label: 'ModelScope (OpenAI-compatible)',
    providerTypeHint: 'openai',
    defaultBaseUrl: 'https://api-inference.modelscope.cn/v1',
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    defaultAuthType: 'apikey'
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI (Cloud Code Assist)',
    providerTypeHint: 'gemini-cli',
    defaultBaseUrl: 'https://cloudcode-pa.googleapis.com',
    defaultModel: 'gemini-2.5-pro',
    defaultAuthType: 'gemini-cli-oauth'
  },
  {
    id: 'antigravity',
    label: 'Antigravity (Gemini CLI dev)',
    providerTypeHint: 'antigravity',
    defaultBaseUrl: 'https://cloudcode-pa.googleapis.com',
    defaultModel: 'gemini-2.5-pro',
    defaultAuthType: 'gemini-cli-oauth'
  },
  {
    id: 'gemini',
    label: 'Gemini HTTP API',
    providerTypeHint: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'models/gemini-2.0-flash',
    defaultAuthType: 'apikey'
  },
  {
    id: 'openai',
    label: 'OpenAI Chat (api.openai.com)',
    providerTypeHint: 'openai',
    defaultBaseUrl: API_ENDPOINTS.OPENAI,
    defaultModel: 'gpt-4.1',
    defaultAuthType: 'apikey'
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages (api.anthropic.com)',
    providerTypeHint: 'anthropic',
    defaultBaseUrl: API_ENDPOINTS.ANTHROPIC,
    defaultModel: 'claude-3.5-sonnet',
    defaultAuthType: 'apikey'
  },
  {
    id: 'responses',
    label: 'Responses-style aggregator (ChatGPT/Codex compatible)',
    providerTypeHint: 'responses',
    defaultAuthType: 'apikey'
  },
  {
    id: 'custom',
    label: 'Custom provider (manual configuration)',
    providerTypeHint: 'openai'
  }
];

function pickTemplate(id?: string): ProviderTemplate {
  const normalized = (id || '').trim().toLowerCase();
  if (!normalized) {
    return PROVIDER_TEMPLATES[0];
  }
  const found = PROVIDER_TEMPLATES.find((t) => t.id === normalized);
  return found ?? PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1];
}

function buildProviderFromTemplate(
  providerId: string,
  tpl: ProviderTemplate,
  baseUrl: string,
  authType: string,
  apiKeyOrPlaceholder: string,
  tokenFile: string,
  primaryModelId: string
): UnknownRecord {
  const auth: UnknownRecord = { type: authType };
  if (authType.toLowerCase().includes('apikey')) {
    if (apiKeyOrPlaceholder.trim()) {
      auth.apiKey = apiKeyOrPlaceholder.trim();
    } else {
      auth.apiKey = 'YOUR_API_KEY_HERE';
    }
  } else if (authType.toLowerCase().includes('oauth')) {
    if (tokenFile.trim()) {
      auth.tokenFile = tokenFile.trim();
    }
  }

  const models: Record<string, UnknownRecord> = {};
  if (primaryModelId.trim()) {
    models[primaryModelId.trim()] = {
      supportsStreaming: true
    };
  }

  const provider: UnknownRecord = {
    id: providerId,
    enabled: true,
    type: tpl.providerTypeHint,
    baseURL: baseUrl,
    auth,
    models
  };

  if (tpl.defaultCompat) {
    (provider as { compatibilityProfile?: string }).compatibilityProfile = tpl.defaultCompat;
  }

  if (tpl.id === 'responses') {
    (provider as UnknownRecord).responses = {
      process: 'chat',
      streaming: 'always'
    };
  }

  return provider;
}

export function createProviderUpdateCommand(): Command {
  const cmd = new Command('provider');

  // provider update (existing behavior)
  const update = new Command('update')
    .description('Update a provider\'s model list and generate a minimal single-provider config')
    .requiredOption('-c, --config <file>', 'Provider input config JSON (contains providerId/type/baseUrl/auth)')
    .option('-p, --provider <id>', 'Override providerId (else read from --config)')
    .option('--write', 'Write files instead of dry-run', false)
    .option('--output-dir <dir>', 'Output directory for provider config and lists (default: ~/.routecodex/provider/<id>)')
    .option('--blacklist-add <items>', 'Add comma-separated model ids to blacklist')
    .option('--blacklist-remove <items>', 'Remove comma-separated model ids from blacklist')
    .option('--blacklist-file <file>', 'Explicit blacklist.json path (overrides output-dir default)')
    .option('--list-only', 'Only list upstream models and exit', false)
    .option('--use-cache', 'Use cached models list on upstream failure', false)
    .option('--probe-keys', 'Probe apiKey list and set auth.apiKey to first working key', false)
    .option('--verbose', 'Verbose logs', false)
    .action(async (opts) => {
      const args = {
        providerId: opts.provider as string | undefined,
        configPath: path.resolve(opts.config as string),
        write: !!opts.write,
        outputDir: opts.outputDir as string | undefined,
        blacklistAdd: splitCsv(opts.blacklistAdd),
        blacklistRemove: splitCsv(opts.blacklistRemove),
        blacklistFile: opts.blacklistFile as string | undefined,
        listOnly: !!opts.listOnly,
        useCache: !!opts.useCache,
        probeKeys: !!opts.probeKeys,
        verbose: !!opts.verbose
      };
      try {
        const result = await updateProviderModels(args);
        if (!args.listOnly) {
          console.log('Provider update summary:');
          console.log(`  provider: ${result.providerId}`);
          console.log(`  total upstream: ${result.totalRemote}`);
          console.log(`  filtered (after blacklist): ${result.filtered}`);
          console.log(`  output: ${result.outputPath}`);
          console.log(`  blacklist: ${result.blacklistPath}`);
        }
      } catch (e: any) {
        console.error('provider update failed:', e?.message || String(e));
        process.exit(1);
      }
    });

  const syncModels = new Command('sync-models')
    .description('Sync upstream model list into an existing provider config.v2.json')
    .argument('<id>', 'Provider id to update (directory name under ~/.routecodex/provider)')
    .option('--root <dir>', 'Override provider root directory')
    .option('--write', 'Write updated config.v2.json (default: dry-run)', false)
    .option('--use-cache', 'Use cached models-latest.json on upstream failure', false)
    .option('--blacklist-add <items>', 'Add comma-separated model ids to blacklist')
    .option('--blacklist-remove <items>', 'Remove comma-separated model ids from blacklist')
    .option('--verbose', 'Verbose logs', false)
    .action(async (
      id: string,
      opts: {
        root?: string;
        write?: boolean;
        useCache?: boolean;
        blacklistAdd?: string;
        blacklistRemove?: string;
        verbose?: boolean;
      }
    ) => {
      const providerId = (id || '').trim();
      if (!providerId) {
        console.error('Provider id is required');
        process.exit(1);
      }

      const root = resolveProviderRoot(opts.root);
      const dir = path.join(root, providerId);
      const v2Path = path.join(dir, 'config.v2.json');
      const blacklistPath = path.join(dir, 'blacklist.json');
      const cachePath = path.join(dir, 'models-latest.json');

      if (!(await fileExists(v2Path))) {
        console.error(`No config.v2.json found for provider "${providerId}" under ${dir}`);
        process.exit(1);
      }

      const raw = await fs.readFile(v2Path, 'utf8');
      let parsed: ProviderConfigV2;
      try {
        parsed = JSON.parse(raw) as ProviderConfigV2;
      } catch (e) {
        console.error('Failed to parse existing config.v2.json:', (e as Error)?.message ?? String(e));
        process.exit(1);
        return;
      }

      const providerNode = (parsed.provider ?? {}) as UnknownRecord;
      const input = buildProviderUpdateInputFromV2(providerId, providerNode);

      // Load/update blacklist
      const blacklist = readBlacklist(blacklistPath);
      const add = splitCsv(opts.blacklistAdd);
      const rem = splitCsv(opts.blacklistRemove);
      if (add.length || rem.length) {
        const set = new Set(blacklist.models);
        for (const item of add) { set.add(item); }
        for (const item of rem) { set.delete(item); }
        blacklist.models = Array.from(set);
        writeBlacklist(blacklistPath, blacklist);
      }

      // Fetch upstream models (with optional cache fallback)
      let modelsRemote: string[] = [];
      let modelsRaw: unknown = null;
      try {
        const res = await fetchModelsFromUpstream(input as unknown as ProviderInputConfig, !!opts.verbose);
        modelsRemote = res.models || [];
        modelsRaw = res.raw ?? null;
        await fs.writeFile(cachePath, `${JSON.stringify({ models: modelsRemote, raw: modelsRaw, updatedAt: Date.now() }, null, 2)}\n`, 'utf8');
      } catch (e) {
        if (!opts.useCache) {
          throw e;
        }
        try {
          const cachedRaw = await fs.readFile(cachePath, 'utf8');
          const cached = JSON.parse(cachedRaw) as { models?: unknown };
          if (!Array.isArray(cached.models)) {
            throw e;
          }
          modelsRemote = cached.models.map((value) => String(value));
        } catch {
          throw e;
        }
      }

      const blacklistSet = new Set(blacklist.models || []);
      const modelsFiltered = modelsRemote.filter((m) => !blacklistSet.has(m));
      if (!modelsFiltered.length) {
        throw new Error(`Upstream returned 0 models after blacklist filter for provider "${providerId}"`);
      }

      const existingModels = normalizeModelsNode((providerNode as { models?: unknown }).models);
      const existingIds = new Set(Object.keys(existingModels));
      const nextIds = Array.from(new Set(modelsFiltered)).sort();
      const nextSet = new Set(nextIds);

      const added: string[] = [];
      const removed: string[] = [];
      const kept: string[] = [];

      for (const modelId of nextIds) {
        if (existingIds.has(modelId)) {
          kept.push(modelId);
        } else {
          added.push(modelId);
        }
      }
      for (const modelId of existingIds) {
        if (!nextSet.has(modelId)) {
          removed.push(modelId);
        }
      }

      const nextModels: Record<string, UnknownRecord> = {};
      for (const modelId of nextIds) {
        const current = existingModels[modelId];
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          nextModels[modelId] = current as UnknownRecord;
        } else {
          nextModels[modelId] = { supportsStreaming: true };
        }
      }
      providerNode.models = nextModels;
      parsed.provider = providerNode;

      if (opts.write) {
        await fs.writeFile(v2Path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        console.log(`Provider "${providerId}" updated: ${v2Path}`);
      } else {
        console.log(`[DRY RUN] Provider "${providerId}" would be updated: ${v2Path}`);
      }
      console.log(`models: upstream=${modelsRemote.length} filtered=${modelsFiltered.length} kept=${kept.length} added=${added.length} removed=${removed.length}`);
    });

  const probeContext = new Command('probe-context')
    .description('Probe context limits for each model (via /v1/responses) and optionally write maxContextTokens into config.v2.json')
    .argument('<id>', 'Provider id to probe (directory name under ~/.routecodex/provider)')
    .option('--root <dir>', 'Override provider root directory')
    .option('--endpoint <url>', 'RouteCodex /v1/responses endpoint (default: $ROUTECODEX_BASE/v1/responses)')
    .option('--key <token>', 'RouteCodex inbound API key (default: $ROUTECODEX_API_KEY or routecodex-test)')
    .option('--encoder <model>', 'tiktoken encoder model for token sizing (default: gpt-4o)', 'gpt-4o')
    .option('--models <items>', 'Only probe these comma-separated model ids')
    .option('--thresholds <items>', 'Comma-separated token thresholds', '128000,150000,180000,200000,256000,512000,1000000')
    .option('--timeout-ms <ms>', 'Per-request timeout (ms)', '60000')
    .option('--write', 'Write maxContextTokens/maxContext back into config.v2.json (default: dry-run)', false)
    .option('--verbose', 'Verbose logs', false)
    .action(async (
      id: string,
      opts: {
        root?: string;
        endpoint?: string;
        key?: string;
        encoder?: string;
        models?: string;
        thresholds?: string;
        timeoutMs?: string;
        write?: boolean;
        verbose?: boolean;
      }
    ) => {
      const providerId = (id || '').trim();
      if (!providerId) {
        console.error('Provider id is required');
        process.exit(1);
      }

      const base =
        (() => {
          const raw =
            typeof opts.endpoint === 'string' && opts.endpoint.trim()
              ? opts.endpoint.trim()
              : typeof process.env.ROUTECODEX_BASE === 'string' && process.env.ROUTECODEX_BASE.trim()
                ? process.env.ROUTECODEX_BASE.trim()
                : 'http://127.0.0.1:5555';
          const normalized = raw.replace(/\/$/, '');
          if (normalized.endsWith('/v1/responses')) {
            return normalized;
          }
          if (normalized.endsWith('/v1')) {
            return `${normalized}/responses`;
          }
          return `${normalized}/v1/responses`;
        })();

      const apiKey =
        typeof opts.key === 'string' && opts.key.trim()
          ? opts.key.trim()
          : typeof process.env.ROUTECODEX_API_KEY === 'string' && process.env.ROUTECODEX_API_KEY.trim()
            ? process.env.ROUTECODEX_API_KEY.trim()
            : typeof process.env.ROUTECODEX_APIKEY === 'string' && process.env.ROUTECODEX_APIKEY.trim()
              ? process.env.ROUTECODEX_APIKEY.trim()
              : 'routecodex-test';

      const encoderModel = typeof opts.encoder === 'string' && opts.encoder.trim() ? opts.encoder.trim() : 'gpt-4o';
      const thresholds = splitTokenThresholds(opts.thresholds);
      if (!thresholds.length) {
        console.error('No valid thresholds provided');
        process.exit(1);
      }

      const timeoutMs = (() => {
        const parsed = Math.floor(Number(opts.timeoutMs));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
      })();

      const onlyModels = splitCsv(opts.models);

      const root = resolveProviderRoot(opts.root);
      const dir = path.join(root, providerId);
      const v2Path = path.join(dir, 'config.v2.json');

      if (!(await fileExists(v2Path))) {
        console.error(`No config.v2.json found for provider "${providerId}" under ${dir}`);
        process.exit(1);
      }

      const raw = await fs.readFile(v2Path, 'utf8');
      let parsed: ProviderConfigV2;
      try {
        parsed = JSON.parse(raw) as ProviderConfigV2;
      } catch (e) {
        console.error('Failed to parse existing config.v2.json:', (e as Error)?.message ?? String(e));
        process.exit(1);
        return;
      }

      const providerNode = (parsed.provider ?? {}) as UnknownRecord;
      const modelsNode = normalizeModelsNode((providerNode as { models?: unknown }).models);
      const modelIds = Object.keys(modelsNode).sort();
      const selectedModelIds = onlyModels.length
        ? modelIds.filter((id) => onlyModels.includes(id))
        : modelIds;

      if (!selectedModelIds.length) {
        console.error('No models found to probe');
        process.exit(1);
      }

      console.log(`Probing provider="${providerId}" models=${selectedModelIds.length} endpoint=${base}`);
      console.log(`thresholds=${thresholds.join(', ')} encoder=${encoderModel} timeoutMs=${timeoutMs}`);

      const results: Array<{
        modelId: string;
        maxPassedTokens: number | null;
        firstFailure?: { threshold: number; status: number; message?: string };
      }> = [];

      let changed = 0;
      for (const modelId of selectedModelIds) {
        console.log(`\n[probe-context] model=${modelId}`);
        // eslint-disable-next-line no-await-in-loop
        const res = await probeContextForModel(modelId, thresholds, {
          endpoint: base,
          apiKey,
          timeoutMs,
          encoderModel
        });
        const max = res.maxPassedTokens;
        if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
          const currentRaw = modelsNode[modelId];
          const record = isRecord(currentRaw) ? { ...currentRaw } : {};
          const prev = typeof (record as { maxContextTokens?: unknown }).maxContextTokens === 'number'
            ? (record as { maxContextTokens?: number }).maxContextTokens
            : undefined;
          (record as { maxContextTokens?: number }).maxContextTokens = max;
          (record as { maxContext?: number }).maxContext = max;
          modelsNode[modelId] = record as UnknownRecord;
          if (prev !== max) {
            changed += 1;
          }
          console.log(`  ✅ maxPassedTokens=${max}${prev !== undefined ? ` (prev=${prev})` : ''}`);
        } else {
          const failure = res.firstFailure;
          console.log(`  ❌ failed at threshold=${failure?.threshold ?? 'unknown'} status=${failure?.status ?? 'unknown'}`);
        }

        results.push({
          modelId,
          maxPassedTokens: res.maxPassedTokens,
          ...(res.firstFailure ? { firstFailure: { threshold: res.firstFailure.threshold, status: res.firstFailure.status, message: res.firstFailure.message } } : {})
        });

        if (opts.verbose && res.firstFailure?.responseSnippet) {
          console.log('  failure snippet:');
          console.log(String(res.firstFailure.responseSnippet).slice(0, 800));
        }
      }

      providerNode.models = modelsNode;
      parsed.provider = providerNode;

      if (opts.write) {
        await fs.writeFile(v2Path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        console.log(`\nProvider "${providerId}" updated: ${v2Path} (models changed=${changed})`);
      } else {
        console.log(`\n[DRY RUN] Provider "${providerId}" would be updated: ${v2Path} (models changed=${changed})`);
      }
      console.log(`Probe results: ${JSON.stringify(results, null, 2)}`);
    });

  // provider list
  const list = new Command('list')
    .description('List provider v2 configs under ~/.routecodex/provider')
    .option('--root <dir>', 'Override provider root directory')
    .option('--json', 'Output raw JSON', false)
    .action(async (opts: { root?: string; json?: boolean }) => {
      const root = resolveProviderRoot(opts.root);
      await ensureDir(root);
      const configs = await loadProviderConfigsV2(root);
      const entries = Object.entries(configs);
      if (opts.json) {
        const payload = entries.map(([id, cfg]) => ({
          providerId: id,
          version: cfg.version,
          provider: cfg.provider
        }));
        console.log(JSON.stringify({ root, providers: payload }, null, 2));
        return;
      }
      if (!entries.length) {
        console.log(`No provider v2 configs found under ${root}`);
        return;
      }
      console.log(`Provider v2 configs under ${root}:`);
      for (const [id, cfg] of entries) {
        const node = cfg.provider as UnknownRecord;
        const type = typeof node.type === 'string' ? node.type : '-';
        const providerType = typeof (node as { providerType?: unknown }).providerType === 'string'
          ? String((node as { providerType?: unknown }).providerType)
          : '-';
        const baseUrl =
          typeof (node as { baseUrl?: unknown }).baseUrl === 'string'
            ? String((node as { baseUrl?: unknown }).baseUrl)
            : typeof (node as { baseURL?: unknown }).baseURL === 'string'
              ? String((node as { baseURL?: unknown }).baseURL)
              : '-';
        const modelsNode = (node as { models?: unknown }).models;
        const modelCount =
          modelsNode && typeof modelsNode === 'object' && !Array.isArray(modelsNode)
            ? Object.keys(modelsNode as Record<string, unknown>).length
            : 0;
        console.log(`- ${id}: type=${type}, providerType=${providerType}, baseUrl=${baseUrl}, models=${modelCount}`);
      }
    });

  // provider add
  const add = new Command('add')
    .description('Interactively create a new provider v2 config')
    .option('-i, --id <id>', 'Provider id (e.g. glm, qwen, iflow, gemini-cli, antigravity, modelscope, kimi, openai)')
    .option('--root <dir>', 'Override provider root directory')
    .action(async (opts: { id?: string; root?: string }) => {
      let providerId = (opts.id || '').trim();
      if (!providerId) {
        providerId = await ask('Provider id (e.g. glm, qwen, iflow, kimi, modelscope, gemini-cli, antigravity, openai)', 'glm');
      }
      if (!providerId.trim()) {
        console.error('Provider id is required');
        process.exit(1);
      }
      const root = resolveProviderRoot(opts.root);
      await ensureDir(root);
      const dir = path.join(root, providerId);
      await ensureDir(dir);
      const v2Path = path.join(dir, 'config.v2.json');
      if (await fileExists(v2Path)) {
        const shouldOverwrite = await askYesNo(`config.v2.json already exists for "${providerId}". Overwrite?`, false);
        if (!shouldOverwrite) {
          console.log('Aborted');
          return;
        }
      }

      console.log('Available provider templates:');
      for (const tpl of PROVIDER_TEMPLATES) {
        console.log(`- ${tpl.id}: ${tpl.label}`);
      }
      const templateIdRaw = await ask('Template id', 'glm');
      const tpl = pickTemplate(templateIdRaw);

      const baseUrlDefault = tpl.defaultBaseUrl ?? '';
      const baseUrl = await ask('Base URL', baseUrlDefault);
      if (!baseUrl.trim()) {
        console.error('Base URL is required');
        process.exit(1);
      }

      const authTypeDefault = tpl.defaultAuthType ?? 'apikey';
      const authType = await ask('Auth type (e.g. apikey, oauth, qwen-oauth, iflow-oauth, gemini-cli-oauth)', authTypeDefault);

      let apiKeyPlaceholder = '';
      let tokenFile = '';
      if (authType.toLowerCase().includes('apikey')) {
        apiKeyPlaceholder = await ask('API key (or placeholder, e.g. ${PROVIDER_API_KEY:-})', 'YOUR_API_KEY_HERE');
      } else if (authType.toLowerCase().includes('oauth')) {
        tokenFile = await ask('Token file path or alias (leave empty to use default)', '');
      }

      const modelDefault = tpl.defaultModel ?? '';
      const primaryModelId = await ask('Primary model id (at least one)', modelDefault);
      if (!primaryModelId.trim()) {
        console.error('Primary model id is required');
        process.exit(1);
      }

      const provider = buildProviderFromTemplate(
        providerId,
        tpl,
        baseUrl,
        authType,
        apiKeyPlaceholder,
        tokenFile,
        primaryModelId
      );

      const payload: ProviderConfigV2 = {
        version: '2.0.0',
        providerId,
        provider
      };

      console.log('\nPlanned config.v2.json content:\n');
      console.log(JSON.stringify(payload, null, 2));
      const confirm = await askYesNo('Write this provider config?', true);
      if (!confirm) {
        console.log('Aborted');
        return;
      }

      await fs.writeFile(v2Path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`Provider "${providerId}" written to ${v2Path}`);
    });

  // provider change
  const change = new Command('change')
    .description('Interactively modify an existing provider v2 config')
    .argument('<id>', 'Provider id to modify')
    .option('--root <dir>', 'Override provider root directory')
    .action(async (id: string, opts: { root?: string }) => {
      const providerId = (id || '').trim();
      if (!providerId) {
        console.error('Provider id is required');
        process.exit(1);
      }
      const root = resolveProviderRoot(opts.root);
      const dir = path.join(root, providerId);
      const v2Path = path.join(dir, 'config.v2.json');
      if (!(await fileExists(v2Path))) {
        console.error(`No config.v2.json found for provider "${providerId}" under ${dir}`);
        process.exit(1);
      }
      const raw = await fs.readFile(v2Path, 'utf8');
      let parsed: ProviderConfigV2;
      try {
        parsed = JSON.parse(raw) as ProviderConfigV2;
      } catch (e) {
        console.error('Failed to parse existing config.v2.json:', (e as Error)?.message ?? String(e));
        process.exit(1);
        return;
      }

      const node = (parsed.provider ?? {}) as UnknownRecord;
      const currentBaseUrl =
        typeof (node as { baseUrl?: unknown }).baseUrl === 'string'
          ? String((node as { baseUrl?: unknown }).baseUrl)
          : typeof (node as { baseURL?: unknown }).baseURL === 'string'
            ? String((node as { baseURL?: unknown }).baseURL)
            : '';
      const baseUrl = await ask('Base URL', currentBaseUrl);
      if (baseUrl.trim()) {
        (node as { baseURL?: string }).baseURL = baseUrl.trim();
      }

      const authNode = ((node as { auth?: unknown }).auth ?? {}) as UnknownRecord;
      const currentAuthType =
        typeof authNode.type === 'string'
          ? authNode.type
          : 'apikey';
      const authType = await ask('Auth type (e.g. apikey, oauth, qwen-oauth, iflow-oauth, gemini-cli-oauth)', currentAuthType);
      authNode.type = authType;

      let apiKeyPlaceholder = typeof (authNode as { apiKey?: unknown }).apiKey === 'string'
        ? String((authNode as { apiKey?: unknown }).apiKey)
        : 'YOUR_API_KEY_HERE';
      let tokenFile = typeof (authNode as { tokenFile?: unknown }).tokenFile === 'string'
        ? String((authNode as { tokenFile?: unknown }).tokenFile)
        : '';

      if (authType.toLowerCase().includes('apikey')) {
        apiKeyPlaceholder = await ask('API key (or placeholder, e.g. ${PROVIDER_API_KEY:-})', apiKeyPlaceholder);
        (authNode as { apiKey?: string }).apiKey = apiKeyPlaceholder;
        delete (authNode as { tokenFile?: unknown }).tokenFile;
      } else if (authType.toLowerCase().includes('oauth')) {
        tokenFile = await ask('Token file path or alias (leave empty to use default)', tokenFile);
        if (tokenFile.trim()) {
          (authNode as { tokenFile?: string }).tokenFile = tokenFile.trim();
        } else {
          delete (authNode as { tokenFile?: unknown }).tokenFile;
        }
        delete (authNode as { apiKey?: unknown }).apiKey;
      }
      (node as { auth?: UnknownRecord }).auth = authNode;

      const modelsNode = ((node as { models?: unknown }).models ?? {}) as Record<string, UnknownRecord>;
      const existingModelIds = Object.keys(modelsNode);
      const currentPrimary = existingModelIds[0] ?? '';
      const primaryModelId = await ask('Primary model id', currentPrimary);
      if (primaryModelId.trim()) {
        if (!modelsNode[primaryModelId.trim()]) {
          modelsNode[primaryModelId.trim()] = { supportsStreaming: true };
        }
      }
      (node as { models?: Record<string, UnknownRecord> }).models = modelsNode;

      parsed.provider = node;

      console.log('\nUpdated config.v2.json content:\n');
      console.log(JSON.stringify(parsed, null, 2));
      const confirm = await askYesNo('Save changes to this provider config?', true);
      if (!confirm) {
        console.log('Aborted');
        return;
      }

      await fs.writeFile(v2Path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      console.log(`Provider "${providerId}" updated at ${v2Path}`);
    });

  // provider delete
  const del = new Command('delete')
    .description('Delete provider v2 config (config.v2.json only by default)')
    .argument('<id>', 'Provider id to delete')
    .option('--root <dir>', 'Override provider root directory')
    .option('--purge', 'Remove entire provider directory (including runtime state)', false)
    .action(async (id: string, opts: { root?: string; purge?: boolean }) => {
      const providerId = (id || '').trim();
      if (!providerId) {
        console.error('Provider id is required');
        process.exit(1);
      }
      const root = resolveProviderRoot(opts.root);
      const dir = path.join(root, providerId);
      const v2Path = path.join(dir, 'config.v2.json');
      const targetDescription = opts.purge ? `directory ${dir}` : `file ${v2Path}`;
      const confirmed = await askYesNo(`Are you sure you want to delete provider "${providerId}" (${targetDescription})?`, false);
      if (!confirmed) {
        console.log('Aborted');
        return;
      }
      try {
        if (opts.purge) {
          await fs.rm(dir, { recursive: true, force: true });
        } else {
          await fs.unlink(v2Path);
        }
        console.log(`Provider "${providerId}" deleted (${targetDescription})`);
      } catch (e) {
        console.error('Failed to delete provider:', (e as Error)?.message ?? String(e));
        process.exit(1);
      }
    });

  cmd.addCommand(update);
  cmd.addCommand(syncModels);
  cmd.addCommand(probeContext);
  cmd.addCommand(list);
  cmd.addCommand(add);
  cmd.addCommand(change);
  cmd.addCommand(del);

  return cmd;
}
