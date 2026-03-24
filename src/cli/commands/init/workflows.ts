import fs from 'node:fs';
import path from 'node:path';

import type { InitProviderTemplate } from '../../config/init-provider-catalog.js';
import {
  asRecord,
  backupFileBestEffort,
  buildRouting,
  buildV2ConfigFromExisting,
  ensureDir,
  ensureTargetProvidersExist,
  getProviderV2Path,
  inferDefaultModel,
  isBackInput,
  loadProviderV2Map,
  normalizeEnvVarName,
  normalizeHost,
  normalizePort,
  printConfiguredProviders,
  readProviderV2Payload,
  readProvidersFromV1,
  readRoutingFromConfig,
  writeJsonFile,
  writeProviderV2,
  computeBackupPath,
  mergeRecordsPreferExisting
} from './basic.js';
import { interactiveCreateCustomProvider, interactiveRoutingWizard } from './interactive.js';
import { promptDuplicateMigrationStrategy, promptDuplicateProviderResolution } from './prompt-utils.js';
import type { LoggerLike, PromptLike, Spinner, UnknownRecord } from './shared.js';
import { isManagedBootstrapTemplate } from '../../config/bootstrap-provider-templates.js';

export async function migrateV1ToV2(args: {
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

  let spinnerPausedForPrompt = false;
  let spinnerResumeText = spinner.text || 'Converting V1 -> V2...';
  const pauseSpinnerForPrompt = () => {
    if (spinnerPausedForPrompt) {
      return;
    }
    try {
      spinnerResumeText = spinner.text || spinnerResumeText;
      spinner.stop();
    } catch {
      // ignore
    }
    spinnerPausedForPrompt = true;
  };
  const resumeSpinnerAfterPrompt = () => {
    if (!spinnerPausedForPrompt) {
      return;
    }
    try {
      spinner.start(spinnerResumeText);
    } catch {
      // ignore
    }
    spinnerPausedForPrompt = false;
  };

  const duplicateProviderIds: string[] = [];
  for (const [providerId] of providerEntries) {
    const v2Path = getProviderV2Path(pathImpl, providerRoot, providerId);
    if (!fsImpl.existsSync(v2Path)) {
      continue;
    }
    duplicateProviderIds.push(providerId);
  }

  const resolutions = new Map<string, 'keep' | 'overwrite' | 'merge'>();
  let strategy: 'overwrite_all' | 'per_provider' | 'keep_all' = 'per_provider';
  if (duplicateProviderIds.length > 0) {
    if (forceOverwriteProviders) {
      strategy = 'overwrite_all';
    } else if (prompt) {
      pauseSpinnerForPrompt();
      strategy = await promptDuplicateMigrationStrategy(prompt, duplicateProviderIds);
    } else {
      strategy = 'keep_all';
      logger.info(
        `Detected existing provider configs (${duplicateProviderIds.join(', ')}); keeping existing config.v2.json in non-interactive mode`
      );
    }

    if (strategy === 'overwrite_all') {
      for (const providerId of duplicateProviderIds) {
        resolutions.set(providerId, 'overwrite');
      }
    } else if (strategy === 'keep_all') {
      for (const providerId of duplicateProviderIds) {
        resolutions.set(providerId, 'keep');
      }
    } else if (prompt) {
      for (const providerId of duplicateProviderIds) {
        resolutions.set(providerId, await promptDuplicateProviderResolution(prompt, providerId));
      }
    }
  }

  resumeSpinnerAfterPrompt();

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

export async function runV2MaintenanceMenu(args: {
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
      `  5) List providers\n` +
      `  6) Save and exit\n` +
      `  7) Exit without changes\n> `
    ))
      .trim();

    if (answer === '1') {
      const mode = (await prompt(
        `Add provider:\n` +
        `  1) Add managed-auth built-in provider\n` +
        `  2) Add external custom provider (guided protocol setup)\n` +
        `  3) Add standard protocol built-in provider\n` +
        `  b) Back\n> `
      )).trim();

      if (isBackInput(mode)) {
        logger.info('Back to V2 menu.');
        continue;
      }

      if (!mode || mode === '1' || mode === '3') {
        const selectedCatalog = catalog.filter((provider) => {
          if (!mode || mode === '1') {
            // Backward compatibility: mode=1 historically listed all built-ins.
            return true;
          }
          return !isManagedBootstrapTemplate(provider.id);
        });
        if (!selectedCatalog.length) {
          logger.info(mode === '3' ? 'No standard protocol built-in providers found.' : 'No managed-auth built-in providers found.');
          continue;
        }
        const lines = selectedCatalog.map((provider, index) => {
          const exists = providerIds.includes(provider.id) ? ' [exists]' : ' [new]';
          return `  ${index + 1}) ${provider.id} - ${provider.label}${exists}`;
        });
        const pickTitle =
          mode === '3'
            ? 'Choose standard protocol built-in provider (b=back):'
            : 'Choose managed-auth built-in provider (b=back):';
        const pick = (await prompt(`${pickTitle}\n${lines.join('\n')}\n> `)).trim();
        if (isBackInput(pick)) {
          logger.info('Back to add-provider menu.');
          continue;
        }
        const index = Number(pick);
        if (!Number.isFinite(index) || index <= 0 || Math.floor(index) > selectedCatalog.length) {
          logger.info('Invalid provider selection.');
          continue;
        }
        const selected = selectedCatalog[Math.floor(index) - 1];

        if (providerIds.includes(selected.id)) {
          const resolution = (await prompt(
            `Provider ${selected.id} already exists. (o)verwrite with built-in template / (k)eep / (b)ack\n> `
          )).trim().toLowerCase();
          if (isBackInput(resolution)) {
            logger.info('Back to add-provider menu.');
            continue;
          }
          if (!resolution || resolution === 'k' || resolution === 'keep') {
            logger.info(`Skipped existing provider: ${selected.id}`);
            continue;
          }
          if (resolution !== 'o' && resolution !== 'overwrite') {
            logger.info('Invalid choice. Use o / k / b.');
            continue;
          }
        }

        const providerNode = asRecord(JSON.parse(JSON.stringify(selected.provider)));
        if (selected.defaultModel) {
          const modelsNode = asRecord(providerNode.models);
          if (!modelsNode[selected.defaultModel]) {
            modelsNode[selected.defaultModel] = { supportsStreaming: true };
          }
          providerNode.models = modelsNode;
          providerNode.defaultModel = selected.defaultModel;
        }
        writeProviderV2(fsImpl, pathImpl, providerRoot, selected.id, providerNode);
        const actionLabel = providerIds.includes(selected.id) ? 'Updated' : 'Added';
        const sourceLabel = mode === '3' ? 'standard provider template' : 'managed-auth provider template';
        logger.info(`${actionLabel} ${sourceLabel}: ${selected.id}`);
        continue;
      }

      if (mode === '2') {
        const created = await interactiveCreateCustomProvider(prompt, new Set(providerIds), logger);
        if (!created) {
          continue;
        }
        writeProviderV2(fsImpl, pathImpl, providerRoot, created.providerId, created.providerNode);
        logger.info(`Added custom provider: ${created.providerId}`);
        continue;
      }

      logger.info('Unknown add mode. Choose 1 (managed-auth built-in), 2 (guided standard provider), or b (back). 3 also supported for standard built-in.');
      continue;
    }

    if (answer === '2') {
      if (!providerIds.length) {
        logger.info('No providers to delete.');
        continue;
      }
      const lines = providerIds.map((providerId, index) => `  ${index + 1}) ${providerId}`);
      const pick = (await prompt(`Choose provider to delete (b=back):\n${lines.join('\n')}\n> `)).trim();
      if (isBackInput(pick)) {
        logger.info('Back to V2 menu.');
        continue;
      }
      const index = Number(pick);
      if (!Number.isFinite(index) || index <= 0 || Math.floor(index) > providerIds.length) {
        logger.info('Invalid provider selection.');
        continue;
      }
      const providerId = providerIds[Math.floor(index) - 1];
      const confirmDelete = (await prompt(`Delete provider ${providerId}? (y/n, b=back)\n> `)).trim().toLowerCase();
      if (isBackInput(confirmDelete)) {
        logger.info('Back to V2 menu.');
        continue;
      }
      if (!(confirmDelete === 'y' || confirmDelete === 'yes')) {
        logger.info(`Delete cancelled: ${providerId}`);
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
      const pick = (await prompt(`Choose provider to modify (b=back):\n${lines.join('\n')}\n> `)).trim();
      if (isBackInput(pick)) {
        logger.info('Back to V2 menu.');
        continue;
      }
      const index = Number(pick);
      if (!Number.isFinite(index) || index <= 0 || Math.floor(index) > providerIds.length) {
        logger.info('Invalid provider selection.');
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
          `  3) Replace with built-in managed-auth template\n` +
          `  4) Save provider\n` +
          `  5) Edit models/defaultModel\n` +
          `  6) Configure auth reference\n` +
          `  b) Back without saving\n> `
        ))
          .trim();

        if (isBackInput(action)) {
          logger.info(`Back to V2 menu without saving provider: ${providerId}`);
          break;
        }

        if (action === '1') {
          providerNode.enabled = providerNode.enabled === false;
          continue;
        }
        if (action === '2') {
          const nextBase = (await prompt('New baseURL (b=back):\n> ')).trim();
          if (isBackInput(nextBase)) {
            logger.info('Back to modify-provider menu.');
            continue;
          }
          if (nextBase) {
            providerNode.baseURL = nextBase;
          }
          continue;
        }
        if (action === '3') {
          const template = catalogById.get(providerId);
          if (!template) {
            logger.info(`No managed-auth template for provider ${providerId}`);
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
        if (action === '5') {
          const modelsNode = asRecord(providerNode.models);
          if (!Object.keys(modelsNode).length) {
            modelsNode['default-model'] = { supportsStreaming: true };
          }
          while (true) {
            const modelIds = Object.keys(modelsNode).sort();
            const currentDefault = typeof providerNode.defaultModel === 'string' && providerNode.defaultModel.trim()
              ? providerNode.defaultModel.trim()
              : modelIds[0];
            const modelAction = (await prompt(
              `Model editor (${providerId}): default=${currentDefault}, models=${modelIds.join(', ')}\n` +
              `  1) Add model ids (comma-separated)\n` +
              `  2) Remove model id\n` +
              `  3) Set default model id\n` +
              `  4) Back\n> `
            )).trim().toLowerCase();
            if (isBackInput(modelAction) || modelAction === '4') {
              break;
            }
            if (modelAction === '1') {
              const raw = (await prompt('Model ids to add (comma-separated, b=back):\n> ')).trim();
              if (isBackInput(raw)) {
                continue;
              }
              const ids = raw.split(',').map((item) => item.trim()).filter(Boolean);
              for (const id of ids) {
                if (!modelsNode[id]) {
                  modelsNode[id] = { supportsStreaming: true };
                }
              }
              providerNode.models = modelsNode;
              continue;
            }
            if (modelAction === '2') {
              const raw = (await prompt('Model id to remove (b=back):\n> ')).trim();
              if (isBackInput(raw)) {
                continue;
              }
              if (!raw || !modelsNode[raw]) {
                logger.info(`Model not found: ${raw || '(empty)'}`);
                continue;
              }
              if (Object.keys(modelsNode).length <= 1) {
                logger.info('At least one model must remain configured.');
                continue;
              }
              delete modelsNode[raw];
              providerNode.models = modelsNode;
              if (providerNode.defaultModel === raw) {
                providerNode.defaultModel = Object.keys(modelsNode)[0];
              }
              continue;
            }
            if (modelAction === '3') {
              const raw = (await prompt('Default model id (must exist, b=back):\n> ')).trim();
              if (isBackInput(raw)) {
                continue;
              }
              if (!raw) {
                logger.info('Default model id cannot be empty.');
                continue;
              }
              if (!modelsNode[raw]) {
                logger.info(`Model "${raw}" is not configured. Add it first.`);
                continue;
              }
              providerNode.defaultModel = raw;
              continue;
            }
            logger.info('Unknown model action. Choose 1/2/3/4.');
          }
          continue;
        }
        if (action === '6') {
          const authNode = asRecord(providerNode.auth);
          while (true) {
            const authType = typeof authNode.type === 'string' ? authNode.type : 'apikey';
            const authAction = (await prompt(
              `Auth editor (${providerId}): type=${authType}\n` +
              `  1) Set auth type\n` +
              `  2) Set API key env placeholder\n` +
              `  3) Set token/cookie file path\n` +
              `  4) Back\n> `
            )).trim().toLowerCase();
            if (isBackInput(authAction) || authAction === '4') {
              break;
            }
            if (authAction === '1') {
              const nextType = (await prompt(`Auth type (current=${authType}, b=back):\n> `)).trim();
              if (isBackInput(nextType)) {
                continue;
              }
              if (!nextType) {
                logger.info('Auth type cannot be empty.');
                continue;
              }
              authNode.type = nextType;
              continue;
            }
            if (authAction === '2') {
              const envDefault = normalizeEnvVarName(providerId);
              const envName = (await prompt(`API key env var (default=${envDefault}, b=back):\n> `)).trim();
              if (isBackInput(envName)) {
                continue;
              }
              const resolvedEnv = envName || envDefault;
              authNode.type = String(authNode.type || 'apikey');
              authNode.apiKey = `\${${resolvedEnv}}`;
              delete authNode.tokenFile;
              delete authNode.cookieFile;
              continue;
            }
            if (authAction === '3') {
              const tokenPath = (await prompt('Token/Cookie file path (b=back):\n> ')).trim();
              if (isBackInput(tokenPath)) {
                continue;
              }
              if (!tokenPath) {
                logger.info('Token/Cookie file path cannot be empty.');
                continue;
              }
              const normalizedType = String(authNode.type || '').toLowerCase();
              if (normalizedType.includes('cookie')) {
                authNode.cookieFile = tokenPath;
                delete authNode.tokenFile;
              } else {
                authNode.tokenFile = tokenPath;
                delete authNode.cookieFile;
              }
              delete authNode.apiKey;
              continue;
            }
            logger.info('Unknown auth action. Choose 1/2/3/4.');
          }
          providerNode.auth = authNode;
          continue;
        }
        logger.info('Unknown modify action. Choose 1/2/3/4/5/6/b.');
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
      if (!nextRouting) {
        logger.info('Back to V2 menu without routing changes.');
        continue;
      }
      const host = normalizeHost(String(asRecord(currentConfig.httpserver).host || '')) || '127.0.0.1';
      const port = normalizePort(asRecord(currentConfig.httpserver).port as string | number | undefined) || 5555;
      currentConfig = buildV2ConfigFromExisting(currentConfig, nextRouting, host, port);
      continue;
    }

    if (answer === '5') {
      printConfiguredProviders(logger, providerMap);
      continue;
    }

    if (answer === '6') {
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

    if (answer === '7') {
      spinner.info('Exit without saving changes to main config.');
      return;
    }
  }
}
