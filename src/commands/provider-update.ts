import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';

import { updateProviderModels } from '../tools/provider-update/index.js';
import { fetchModelsFromUpstream } from '../tools/provider-update/fetch-models.js';
import { readBlacklist, writeBlacklist } from '../tools/provider-update/blacklist.js';
import { probeContextForModel } from '../tools/provider-update/probe-context.js';
import type { ProviderInputConfig } from '../tools/provider-update/types.js';
import { loadRouteCodexConfig } from '../config/routecodex-config-loader.js';
import type { ProviderConfigV2 } from '../config/provider-v2-loader.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';
import {
  __providerUpdateTestables,
  buildProviderUpdateInputFromV2,
  countRouteTargets,
  fileExists,
  isRecord,
  normalizeModelsNode,
  resolveProviderRoot,
  splitCsv,
  splitTokenThresholds
} from './provider-update-shared.js';
import {
  createAddCommand,
  createChangeCommand,
  createDeleteCommand,
  createDoctorCommand,
  createInspectCommand,
  createListCommand
} from './provider-update-maintenance.js';

export { __providerUpdateTestables };

function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update a provider\'s model list and generate a minimal single-provider config')
    .requiredOption('-c, --config <file>', 'Provider input config JSON (contains providerId/type/baseUrl/auth)')
    .option('-p, --provider <id>', 'Override providerId (else read from --config)')
    .option('--write', 'Write files instead of dry-run', false)
    .option('--output-dir <dir>', 'Output directory for provider config and lists (default: ~/.rcc/provider/<id>)')
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
}

function createSyncModelsCommand(): Command {
  return new Command('sync-models')
    .description('Sync upstream model list into an existing provider config.v2.json')
    .argument('<id>', 'Provider id to update (directory name under ~/.rcc/provider)')
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
}

function createProbeContextCommand(): Command {
  return new Command('probe-context')
    .description('Probe context limits for each model (via /v1/responses) and optionally write maxContextTokens into config.v2.json')
    .argument('<id>', 'Provider id to probe (directory name under ~/.rcc/provider)')
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
        ? modelIds.filter((entry) => onlyModels.includes(entry))
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
}

function createSyncCapabilityRoutesCommand(): Command {
  return new Command('sync-capability-routes')
    .description('Sync capability-driven multimodal/vision/web_search routes into active v2 routing policy (config-first, missing-only)')
    .option('-c, --config <file>', 'RouteCodex config path (default: auto-resolve ~/.rcc/config.json)')
    .action(async (opts: { config?: string }) => {
      const explicitConfig = typeof opts.config === 'string' && opts.config.trim()
        ? path.resolve(opts.config.trim())
        : undefined;

      try {
        const beforeContent =
          explicitConfig && (await fileExists(explicitConfig))
            ? await fs.readFile(explicitConfig, 'utf8')
            : undefined;

        const loaded = await loadRouteCodexConfig(explicitConfig);
        const configPath = loaded.configPath;
        const afterContent = await fs.readFile(configPath, 'utf8');
        const changed = beforeContent !== undefined ? beforeContent !== afterContent : undefined;

        const virtualrouter = isRecord((loaded.userConfig as UnknownRecord).virtualrouter)
          ? ((loaded.userConfig as UnknownRecord).virtualrouter as UnknownRecord)
          : {};
        const routing = isRecord(virtualrouter.routing)
          ? (virtualrouter.routing as UnknownRecord)
          : {};
        const multimodalTargets = countRouteTargets(routing.multimodal);
        const visionTargets = countRouteTargets(routing.vision);
        const webSearchTargets = countRouteTargets(routing.web_search);
        const searchAliasTargets = countRouteTargets(routing.search);

        console.log(`Capability route sync: ${configPath}`);
        if (changed !== undefined) {
          console.log(`  updated: ${changed ? 'yes' : 'no'}`);
        }
        console.log(`  multimodal targets: ${multimodalTargets}`);
        console.log(`  vision targets: ${visionTargets}`);
        console.log(`  web_search targets: ${webSearchTargets}`);
        if (searchAliasTargets > 0) {
          console.log(`  search(alias) targets: ${searchAliasTargets}`);
        }
      } catch (e) {
        console.error('provider sync-capability-routes failed:', (e as Error)?.message ?? String(e));
        process.exit(1);
      }
    });
}

export function createProviderUpdateCommand(): Command {
  const cmd = new Command('provider');

  cmd.addCommand(createUpdateCommand());
  cmd.addCommand(createInspectCommand());
  cmd.addCommand(createDoctorCommand());
  cmd.addCommand(createSyncModelsCommand());
  cmd.addCommand(createProbeContextCommand());
  cmd.addCommand(createSyncCapabilityRoutesCommand());
  cmd.addCommand(createListCommand());
  cmd.addCommand(createAddCommand());
  cmd.addCommand(createChangeCommand());
  cmd.addCommand(createDeleteCommand());

  return cmd;
}
