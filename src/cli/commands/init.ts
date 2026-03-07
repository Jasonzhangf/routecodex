import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

import { getBootstrapProviderTemplates } from '../config/bootstrap-provider-templates.js';
import { buildCatalogWebSearchDefaults, type InitProviderTemplate } from '../config/init-provider-catalog.js';
import { parseProvidersArg } from '../config/init-config.js';
import { buildV2ConfigObject } from '../config/init-v2-builder.js';
import { installBundledDocsBestEffort } from '../config/bundled-docs.js';
import { ensureDefaultPrecommandScriptBestEffort } from '../config/precommand-default-script.js';
import {
  asRecord,
  buildRouting,
  computeBackupPath,
  ensureDir,
  getProviderRoot,
  inspectConfigState,
  loadProviderV2Map,
  normalizeHost,
  normalizePort,
  printConfiguredProviders,
  resolveSelectedTemplates,
  writeJsonFile,
  writeProviderV2
} from './init/basic.js';
import { buildInteractivePrompt } from './init/prompt-utils.js';
import {
  maybePrepareCamoufoxEnvironment,
  shouldPrepareCamoufoxForProviderMap,
  shouldPrepareCamoufoxForTemplates
} from './init/camoufox.js';
import {
  interactiveHostPort,
  interactivePickDefaultProvider,
  interactiveRoutingWizard,
  interactiveSelectProviders,
  promptYesNo
} from './init/interactive.js';
import { migrateV1ToV2, runV2MaintenanceMenu } from './init/workflows.js';
import type { InitCommandContext, InitCommandOptions } from './init/shared.js';

export type { InitCommandContext } from './init/shared.js';

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
  ${bin} init --camoufox
  ${bin} init --list-providers
  ${bin} init --list-current-providers
  ${bin} init --providers openai,qwen --default-provider qwen
`
    )
    .option('-c, --config <config>', 'Configuration file path')
    .option('-f, --force', 'Force overwrite existing configuration during fresh setup')
    .option('--camoufox', 'Force Camoufox environment preparation')
    .option('--providers <ids>', 'Providers (comma-separated), e.g. openai,qwen,iflow')
    .option('--default-provider <id>', 'Default provider id for routing.default')
    .option('--host <host>', 'Server host (httpserver.host)')
    .option('--port <port>', 'Server port (httpserver.port)')
    .option('--list-providers', 'List guided protocol templates + managed-auth provider ids and exit')
    .option('--list-current-providers', 'List configured providers from ~/.routecodex/provider and exit')
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
      const forceCamoufoxPrep = Boolean(options.camoufox);
      const autoCamoufoxPrep = !forceCamoufoxPrep;
      const providerRoot = getProviderRoot(pathImpl, home());

      const catalog = getBootstrapProviderTemplates();
      const catalogById = new Map(catalog.map((provider) => [provider.id, provider]));
      const supported = catalog.map((provider) => provider.id).join(', ');

      if (options.listProviders) {
        spinner.stop();
        for (const entry of catalog) {
          ctx.logger.info(`${entry.id} - ${entry.label}: ${entry.description}`);
        }
        return;
      }

      if (options.listCurrentProviders) {
        spinner.stop();
        const providerMap = loadProviderV2Map(fsImpl, pathImpl, providerRoot);
        printConfiguredProviders(ctx.logger, providerMap);
        return;
      }

      const providersFromArg = parseProvidersArg(options.providers);
      const promptBundle = buildInteractivePrompt(ctx);
      const ensureDefaultPrecommandScript = () => {
        const defaultPrecommand = ensureDefaultPrecommandScriptBestEffort({
          fsImpl,
          pathImpl,
          homeDir: home()
        });
        if (!defaultPrecommand.ok) {
          ctx.logger.warning(
            `Failed to ensure default precommand script (${defaultPrecommand.scriptPath}): ${defaultPrecommand.message || 'unknown error'}`
          );
        }
      };

      try {
        if (forceCamoufoxPrep) {
          maybePrepareCamoufoxEnvironment(ctx, ctx.logger, true, { force: true });
        }

        const state = inspectConfigState(fsImpl, configPath);
        if (state.kind === 'invalid') {
          spinner.fail('Failed to initialize configuration');
          ctx.logger.error(`Invalid JSON in configuration file: ${state.message}`);
          return;
        }

        if (state.kind === 'missing') {
          const shouldInstallBundledDefault =
            (!providersFromArg || providersFromArg.length === 0) &&
            !options.defaultProvider &&
            options.host === undefined &&
            options.port === undefined;

          if (shouldInstallBundledDefault) {
            const defaultTemplate = catalog[0];
            if (!defaultTemplate) {
              spinner.fail('Failed to initialize configuration');
              ctx.logger.error('No bootstrap provider templates available for default initialization');
              return;
            }
            ensureDir(fsImpl, pathImpl.dirname(configPath));
            ensureDir(fsImpl, providerRoot);
            writeProviderV2(fsImpl, pathImpl, providerRoot, defaultTemplate.id, asRecord(defaultTemplate.provider));
            const defaultTarget = `${defaultTemplate.id}.${defaultTemplate.defaultModel}`;
            const configPayload = buildV2ConfigObject({
              host: '127.0.0.1',
              port: 5555,
              routing: buildRouting(defaultTarget)
            });
            writeJsonFile(fsImpl, configPath, configPayload);
            ensureDefaultPrecommandScript();
            spinner.succeed(`Configuration initialized: ${configPath}`);
            ctx.logger.info(`Providers: ${defaultTemplate.id}`);
            ctx.logger.info(`Default provider: ${defaultTemplate.id}`);
            ctx.logger.info(`Provider root: ${providerRoot}`);
            maybePrepareCamoufoxEnvironment(ctx, ctx.logger, autoCamoufoxPrep);
            const installedDocs = installBundledDocsBestEffort({ fsImpl, pathImpl });
            if (installedDocs.ok) {
              ctx.logger.info(`Docs installed: ${installedDocs.targetDir}`);
            }
            ctx.logger.info('Created a minimal V2 config and provider directory layout. Standard protocols stay generic; managed-auth providers keep built-in runtime defaults.');
            return;
          }

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
            ? (safeSpinnerStop(), (await interactiveRoutingWizard(promptBundle.prompt, baseRouting, defaultTarget)) ?? baseRouting)
            : baseRouting;
          const webSearchDefaults = buildCatalogWebSearchDefaults(selectedTemplates);
          const routingWithWebSearch = { ...(routing as Record<string, unknown>) };
          if (webSearchDefaults) {
            const existingWebSearchRoute = routingWithWebSearch.web_search;
            if (!Array.isArray(existingWebSearchRoute) || existingWebSearchRoute.length === 0) {
              routingWithWebSearch.web_search = [
                {
                  id: 'web_search-primary',
                  targets: webSearchDefaults.routeTargets,
                  loadBalancing: {
                    strategy: 'weighted',
                    weights: Object.fromEntries(webSearchDefaults.routeTargets.map((target) => [target, 1]))
                  }
                }
              ];
            }
          }

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

          const configPayload = buildV2ConfigObject({
            host,
            port,
            routing: routingWithWebSearch,
            policyOptions: webSearchDefaults ? { webSearch: webSearchDefaults.webSearch } : undefined
          });
          writeJsonFile(fsImpl, configPath, configPayload);
          ensureDefaultPrecommandScript();

          spinner.succeed(`Configuration initialized: ${configPath}`);
          if (backupPath) {
            ctx.logger.info(`Backed up existing config: ${backupPath}`);
          }
          ctx.logger.info(`Providers: ${selectedProviderIds.join(', ')}`);
          ctx.logger.info(`Default provider: ${defaultProviderId}`);
          ctx.logger.info(`Provider root: ${providerRoot}`);
          maybePrepareCamoufoxEnvironment(
            ctx,
            ctx.logger,
            autoCamoufoxPrep && shouldPrepareCamoufoxForTemplates(selectedTemplates)
          );
          const installed = installBundledDocsBestEffort({ fsImpl, pathImpl });
          if (installed.ok) {
            ctx.logger.info(`Docs installed: ${installed.targetDir}`);
          }
          ctx.logger.info('Next: edit provider baseURL/model/auth in provider/*.json as needed, then run: rcc start');
          return;
        }

        if (state.kind === 'v1') {
          let doConvert = Boolean(options.force);
          if (promptBundle) {
            safeSpinnerStop();
            doConvert = await promptYesNo(promptBundle.prompt, 'Detected V1 config. Convert to V2 now?', true);
          }
          if (!doConvert) {
            ctx.logger.info('Skipped V1 -> V2 conversion.');
            return;
          }

          ctx.logger.info('Starting V1 -> V2 conversion...');
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
          ensureDefaultPrecommandScript();

          spinner.succeed(`Converted V1 -> V2: ${configPath}`);
          ctx.logger.info(`Converted V1 -> V2: ${configPath}`);
          if (migrated.backupPath) {
            ctx.logger.info(`Backup saved: ${migrated.backupPath}`);
          }
          ctx.logger.info(`Migrated providers: ${migrated.convertedProviders.join(', ')}`);
          ctx.logger.info(`Provider root: ${providerRoot}`);
          const migratedProviderMap = loadProviderV2Map(fsImpl, pathImpl, providerRoot);
          maybePrepareCamoufoxEnvironment(
            ctx,
            ctx.logger,
            autoCamoufoxPrep && shouldPrepareCamoufoxForProviderMap(migratedProviderMap)
          );

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
