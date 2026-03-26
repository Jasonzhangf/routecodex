import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runVercelAiProviderDoctor } from '../provider-sdk/vercel-ai-doctor.js';
import { buildProviderFromTemplate, getProviderTemplates, pickProviderTemplate } from '../provider-sdk/provider-add-template.js';
import { buildRoutingHintsConfigFragment, inspectProviderConfig } from '../provider-sdk/provider-inspect.js';
import { loadProviderConfigsV2, type ProviderConfigV2 } from '../config/provider-v2-loader.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';
import {
  ask,
  askYesNo,
  authTypeUsesCredentialFile,
  ensureDir,
  fileExists,
  normalizeEnvVarName,
  normalizeModelsNode,
  parseUniqueModelIds,
  readCredentialFileFromAuthNode,
  readString,
  resolveProviderRoot
} from './provider-update-shared.js';

export function createInspectCommand(): Command {
  return new Command('inspect')
    .description('Show normalized provider metadata from config.v2.json plus catalog defaults')
    .argument('<id>', 'Provider id to inspect (directory name under ~/.rcc/provider)')
    .option('--root <dir>', 'Override provider root directory')
    .option('--json', 'Output raw JSON', false)
    .option('--routing-hints', 'Include suggested routing/webSearch snippets', false)
    .action(async (
      id: string,
      opts: { root?: string; json?: boolean; routingHints?: boolean }
    ) => {
      const providerId = (id || '').trim();
      if (!providerId) {
        console.error('Provider id is required');
        process.exit(1);
      }
      const root = resolveProviderRoot(opts.root);
      await ensureDir(root);
      const configs = await loadProviderConfigsV2(root);
      const cfg = configs[providerId];
      if (!cfg) {
        console.error(`No config.v2.json found for provider "${providerId}" under ${root}`);
        process.exit(1);
      }
      const configPath = path.join(root, providerId, 'config.v2.json');
      const inspection = inspectProviderConfig(cfg, { configPath, includeRoutingHints: Boolean(opts.routingHints) });
      if (opts.json) {
        console.log(JSON.stringify(inspection, null, 2));
        return;
      }
      console.log(`Provider inspect: ${inspection.providerId}`);
      console.log(`  path: ${configPath}`);
      console.log(`  version: ${inspection.version}`);
      console.log(`  type: ${inspection.providerType}`);
      if (inspection.baseURL) {
        console.log(`  baseURL: ${inspection.baseURL}`);
      }
      if (inspection.authType) {
        console.log(`  auth: ${inspection.authType}`);
      }
      if (inspection.compatibilityProfile) {
        console.log(`  compatibilityProfile: ${inspection.compatibilityProfile}`);
      }
      if (inspection.catalogId || inspection.catalogLabel) {
        console.log(`  catalog: ${inspection.catalogId ?? '-'}${inspection.catalogLabel ? ` (${inspection.catalogLabel})` : ''}`);
      }
      console.log(`  defaultModel: ${inspection.defaultModel || '-'}`);
      console.log(`  routeTarget.default: ${inspection.routeTargets.default}`);
      if (inspection.routeTargets.webSearch) {
        console.log(`  routeTarget.web_search: ${inspection.routeTargets.webSearch}`);
      }
      console.log(`  models (${inspection.modelCount}): ${inspection.models.join(', ') || '-'}`);
      if (inspection.sdkBinding) {
        console.log(`  sdkBinding: ${JSON.stringify(inspection.sdkBinding)}`);
      }
      if (inspection.capabilities && Object.keys(inspection.capabilities).length) {
        console.log(`  capabilities: ${Object.keys(inspection.capabilities).join(', ')}`);
      }
      if (inspection.webSearch) {
        console.log(`  webSearch: ${JSON.stringify(inspection.webSearch)}`);
      }
      if (inspection.routingHints) {
        console.log('  routingHints:');
        console.log(JSON.stringify(inspection.routingHints, null, 2));
        console.log('  configFragment:');
        console.log(JSON.stringify(buildRoutingHintsConfigFragment(inspection.routingHints), null, 2));
      }
    });
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Probe a provider v2 config via the Vercel AI SDK compatibility layer')
    .argument('<id>', 'Provider id to probe (directory name under ~/.rcc/provider)')
    .option('--root <dir>', 'Override provider root directory')
    .option('--model <id>', 'Override model id (defaults to provider.defaultModel or the first configured model)')
    .option('--prompt <text>', 'Prompt to use for the text probe', 'Reply with exactly OK.')
    .option('--json', 'Output raw JSON', false)
    .action(async (
      id: string,
      opts: { root?: string; model?: string; prompt?: string; json?: boolean }
    ) => {
      const providerId = (id || '').trim();
      if (!providerId) {
        console.error('Provider id is required');
        process.exit(1);
      }
      const root = resolveProviderRoot(opts.root);
      await ensureDir(root);
      const configs = await loadProviderConfigsV2(root);
      const cfg = configs[providerId];
      if (!cfg) {
        console.error(`No config.v2.json found for provider "${providerId}" under ${root}`);
        process.exit(1);
      }
      const providerNode = (cfg.provider ?? {}) as UnknownRecord;
      const modelsNode = normalizeModelsNode((providerNode as { models?: unknown }).models);
      const inferredModel = readString((providerNode as { defaultModel?: unknown }).defaultModel) || Object.keys(modelsNode)[0] || '';
      const modelId = (opts.model || inferredModel).trim();
      if (!modelId) {
        console.error(`Provider "${providerId}" has no configured models; pass --model explicitly.`);
        process.exit(1);
      }
      const result = await runVercelAiProviderDoctor({
        providerId,
        providerNode,
        modelId,
        prompt: opts.prompt
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Provider doctor: ${providerId}`);
        console.log(`  model: ${modelId}`);
        console.log(`  binding: ${result.binding.family}${result.binding.supported ? '' : ' (runtime-only)'}`);
        if (result.baseURL) {
          console.log(`  baseURL: ${result.baseURL}`);
        }
        console.log(`  status: ${result.ok ? 'ok' : 'failed'}`);
        console.log(`  message: ${result.message}`);
        if (typeof result.text === 'string' && result.text.trim()) {
          console.log(`  text: ${result.text.slice(0, 200)}`);
        }
      }
      if (!result.ok) {
        process.exit(1);
      }
    });
}

export function createListCommand(): Command {
  return new Command('list')
    .description('List provider v2 configs under ~/.rcc/provider')
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
}

export function createAddCommand(): Command {
  return new Command('add')
    .description('Interactively create a new provider v2 config (guided standard protocols + managed-auth built-ins)')
    .option('-i, --id <id>', 'Provider id (e.g. my-openai, qwen, iflow, gemini-cli, antigravity, deepseek-web)')
    .option('--root <dir>', 'Override provider root directory')
    .action(async (opts: { id?: string; root?: string }) => {
      let providerId = (opts.id || '').trim();
      if (!providerId) {
        providerId = await ask('Provider id (e.g. my-openai, qwen, iflow, gemini-cli, antigravity, deepseek-web)', 'glm');
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

      console.log('Available provider templates (guided protocols + managed-auth built-ins):');
      for (const tpl of getProviderTemplates()) {
        console.log(`- ${tpl.id}: ${tpl.label}`);
      }
      const templateIdRaw = await ask('Template id', 'openai');
      const tpl = pickProviderTemplate(templateIdRaw);

      const baseUrlDefault = tpl.defaultBaseUrl ?? '';
      const baseUrl = await ask('Base URL', baseUrlDefault);
      if (!baseUrl.trim()) {
        console.error('Base URL is required');
        process.exit(1);
      }

      const authTypeDefault = tpl.defaultAuthType ?? 'apikey';
      const authType = await ask('Auth type (e.g. apikey, qwen-oauth, iflow-cookie, gemini-cli-oauth, antigravity-oauth, deepseek-account)', authTypeDefault);

      let apiKeyPlaceholder = '';
      let tokenFile = '';
      if (authType.toLowerCase().includes('apikey')) {
        const envDefault = normalizeEnvVarName(providerId);
        const envName = await ask('API key env var name (config writes ${ENV_VAR})', envDefault);
        const resolved = envName.trim() || envDefault;
        apiKeyPlaceholder = `\${${resolved}}`;
      } else if (authTypeUsesCredentialFile(authType)) {
        tokenFile = await ask('Token/cookie file path or alias (leave empty to use default)', '');
      }

      const modelDefault = tpl.defaultModel ?? '';
      const modelsRaw = await ask('Model ids (comma-separated, first is default)', modelDefault);
      const modelIds = parseUniqueModelIds(modelsRaw, modelDefault);
      if (!modelIds.length) {
        console.error('At least one model id is required');
        process.exit(1);
      }
      const defaultModelId = await ask('Default model id', modelIds[0]);

      const provider = buildProviderFromTemplate(
        providerId,
        tpl,
        baseUrl,
        authType,
        apiKeyPlaceholder,
        tokenFile,
        modelIds[0],
        {
          additionalModelIds: modelIds.slice(1),
          defaultModelId: defaultModelId.trim() || modelIds[0]
        }
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
      const inspection = inspectProviderConfig(payload, { configPath: v2Path, includeRoutingHints: true });
      if (inspection.routingHints) {
        console.log('Suggested config fragment for ~/.rcc/config.json:');
        console.log(JSON.stringify(buildRoutingHintsConfigFragment(inspection.routingHints), null, 2));
      }
    });
}

export function createChangeCommand(): Command {
  return new Command('change')
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
      const authType = await ask('Auth type (e.g. apikey, qwen-oauth, iflow-cookie, gemini-cli-oauth, antigravity-oauth, deepseek-account)', currentAuthType);
      authNode.type = authType;

      let apiKeyPlaceholder = typeof (authNode as { apiKey?: unknown }).apiKey === 'string'
        ? String((authNode as { apiKey?: unknown }).apiKey)
        : '';
      let tokenFile = readCredentialFileFromAuthNode(authNode);

      if (authType.toLowerCase().includes('apikey')) {
        const envDefault =
          (apiKeyPlaceholder.match(/^\$\{([A-Za-z0-9_]+)\}$/)?.[1]) ||
          normalizeEnvVarName(providerId);
        const envName = await ask('API key env var name (config writes ${ENV_VAR})', envDefault);
        const resolved = envName.trim() || envDefault;
        (authNode as { apiKey?: string }).apiKey = `\${${resolved}}`;
        delete (authNode as { tokenFile?: unknown }).tokenFile;
      } else if (authTypeUsesCredentialFile(authType)) {
        tokenFile = await ask('Token/cookie file path or alias (leave empty to use default)', tokenFile);
        if (tokenFile.trim()) {
          if (authType.toLowerCase().includes('cookie')) {
            (authNode as { cookieFile?: string }).cookieFile = tokenFile.trim();
            delete (authNode as { tokenFile?: unknown }).tokenFile;
          } else if (authType.toLowerCase().includes('account') && Array.isArray((authNode as { entries?: unknown }).entries) && typeof (authNode as { entries?: unknown[] }).entries?.[0] === 'object' && (authNode as { entries?: unknown[] }).entries?.[0] !== null && !Array.isArray((authNode as { entries?: unknown[] }).entries?.[0])) {
            ((authNode as { entries: UnknownRecord[] }).entries[0]).tokenFile = tokenFile.trim();
            delete (authNode as { tokenFile?: unknown }).tokenFile;
          } else {
            (authNode as { tokenFile?: string }).tokenFile = tokenFile.trim();
            delete (authNode as { cookieFile?: unknown }).cookieFile;
          }
        } else {
          delete (authNode as { tokenFile?: unknown }).tokenFile;
          delete (authNode as { cookieFile?: unknown }).cookieFile;
        }
        delete (authNode as { apiKey?: unknown }).apiKey;
      }
      (node as { auth?: UnknownRecord }).auth = authNode;

      const modelsNode = ((node as { models?: unknown }).models ?? {}) as Record<string, UnknownRecord>;
      const existingModelIds = Object.keys(modelsNode);
      const currentPrimary = existingModelIds[0] ?? '';
      const currentDefaultModel = readString((node as { defaultModel?: unknown }).defaultModel) || currentPrimary;
      const modelsRaw = await ask('Model ids (comma-separated, first is default)', existingModelIds.join(',') || currentPrimary);
      const modelIds = parseUniqueModelIds(modelsRaw, currentPrimary || currentDefaultModel || 'default-model');
      const nextModels: Record<string, UnknownRecord> = {};
      for (const modelId of modelIds) {
        nextModels[modelId] = (modelsNode[modelId] && typeof modelsNode[modelId] === 'object' && !Array.isArray(modelsNode[modelId])) ? modelsNode[modelId] : { supportsStreaming: true };
      }
      const defaultModelId = await ask('Default model id', currentDefaultModel || modelIds[0]);
      const resolvedDefaultModel = defaultModelId.trim() || modelIds[0];
      if (!nextModels[resolvedDefaultModel]) {
        nextModels[resolvedDefaultModel] = { supportsStreaming: true };
      }
      (node as { models?: Record<string, UnknownRecord> }).models = nextModels;
      (node as { defaultModel?: string }).defaultModel = resolvedDefaultModel;

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
}

export function createDeleteCommand(): Command {
  return new Command('delete')
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
}
