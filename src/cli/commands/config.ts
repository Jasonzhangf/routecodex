import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Command } from 'commander';

import { initializeConfigV1, parseProvidersArg } from '../config/init-config.js';
import { resolveRccConfigFile } from '../../config/user-data-paths.js';
import { getBootstrapProviderTemplates } from '../config/bootstrap-provider-templates.js';
import { installBundledDocsBestEffort } from '../config/bundled-docs.js';
import { loadProviderConfigsV2 } from '../../config/provider-v2-loader.js';

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

export type ConfigCommandContext = {
  logger: LoggerLike;
  createSpinner: (text: string) => Promise<Spinner>;
  getHomeDir?: () => string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'dirname' | 'resolve'>;
  spawnImpl?: typeof spawn;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
  findListeningPids?: (port: number) => number[];
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  loadProviderConfigsV2?: () => Promise<Record<string, { provider: Record<string, unknown> }>>;
};

type JsonRecord = Record<string, unknown>;

type RoutingPolicyGroup = {
  routing: Record<string, unknown>;
  loadBalancing?: Record<string, unknown>;
  classifier?: Record<string, unknown>;
  health?: Record<string, unknown>;
  contextRouting?: Record<string, unknown>;
  webSearch?: Record<string, unknown>;
  execCommandGuard?: Record<string, unknown>;
  session?: Record<string, unknown>;
};

const ROUTING_POLICY_OPTIONAL_KEYS = [
  'loadBalancing',
  'classifier',
  'health',
  'contextRouting',
  'webSearch',
  'execCommandGuard',
  'session'
] as const;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function cloneRecord<T extends JsonRecord>(value: T): T {
  return { ...(value as JsonRecord) } as T;
}

function detectRoutingLocation(root: JsonRecord): 'virtualrouter.routing' | 'routing' {
  return asRecord(root.virtualrouter) ? 'virtualrouter.routing' : 'routing';
}

function getLocationContainer(root: JsonRecord, location: 'virtualrouter.routing' | 'routing'): JsonRecord {
  if (location === 'routing') {
    return root;
  }
  return asRecord(root.virtualrouter) ?? {};
}

function withLocationContainer(
  root: JsonRecord,
  location: 'virtualrouter.routing' | 'routing',
  updater: (container: JsonRecord) => JsonRecord
): JsonRecord {
  if (location === 'routing') {
    return updater(cloneRecord(root));
  }
  const vr = asRecord(root.virtualrouter) ?? {};
  return {
    ...root,
    virtualrouter: updater(cloneRecord(vr))
  };
}

function normalizeRoutingPolicyGroupNode(input: unknown): RoutingPolicyGroup {
  const node = asRecord(input) ?? {};
  const routing = asRecord(node.routing) ?? {};
  const out: RoutingPolicyGroup = { routing: cloneRecord(routing) };
  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = asRecord(node[key]);
    if (value) {
      (out as JsonRecord)[key] = cloneRecord(value);
    }
  }
  return out;
}

function resolveActiveGroupId(groups: Record<string, RoutingPolicyGroup>, preferred: unknown): string {
  const names = Object.keys(groups);
  if (!names.length) {
    return 'default';
  }
  if (typeof preferred === 'string' && preferred.trim() && groups[preferred.trim()]) {
    return preferred.trim();
  }
  if (groups.default) {
    return 'default';
  }
  return names.sort((a, b) => a.localeCompare(b))[0];
}

function extractRoutingGroupsSnapshot(config: unknown): {
  groups: Record<string, RoutingPolicyGroup>;
  activeGroupId: string;
  location: 'virtualrouter.routing' | 'routing';
  hasRoutingPolicyGroups: boolean;
} {
  const root = asRecord(config) ?? {};
  const location = detectRoutingLocation(root);
  const container = getLocationContainer(root, location);
  const groupsNode = asRecord(container.routingPolicyGroups);
  const groups: Record<string, RoutingPolicyGroup> = {};
  if (groupsNode) {
    for (const [groupId, groupNode] of Object.entries(groupsNode)) {
      const key = groupId.trim();
      if (!key) continue;
      groups[key] = normalizeRoutingPolicyGroupNode(groupNode);
    }
  }
  if (!Object.keys(groups).length) {
    groups.default = normalizeRoutingPolicyGroupNode(container);
  }
  const activeGroupId = resolveActiveGroupId(groups, container.activeRoutingPolicyGroup);
  return {
    groups,
    activeGroupId,
    location,
    hasRoutingPolicyGroups: Boolean(groupsNode)
  };
}

function serializeRoutingGroups(groups: Record<string, RoutingPolicyGroup>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const groupId of Object.keys(groups).sort((a, b) => a.localeCompare(b))) {
    const group = groups[groupId];
    const row: JsonRecord = { routing: cloneRecord(group.routing) };
    for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
      const value = asRecord((group as JsonRecord)[key]);
      if (value) row[key] = cloneRecord(value);
    }
    out[groupId] = row;
  }
  return out;
}

function materializePolicyIntoContainer(container: JsonRecord, policy: RoutingPolicyGroup): JsonRecord {
  const next: JsonRecord = { ...container, routing: cloneRecord(policy.routing) };
  for (const key of ROUTING_POLICY_OPTIONAL_KEYS) {
    const value = asRecord((policy as JsonRecord)[key]);
    if (value) {
      next[key] = cloneRecord(value);
    } else {
      delete next[key];
    }
  }
  return next;
}

function applyRoutingGroupsIntoConfig(config: unknown, groups: Record<string, RoutingPolicyGroup>, activeGroupId: string): JsonRecord {
  const root = asRecord(config) ?? {};
  const location = detectRoutingLocation(root);
  return withLocationContainer(root, location, (container) => {
    const activePolicy = groups[activeGroupId] ?? { routing: {} };
    const next = materializePolicyIntoContainer(container, activePolicy);
    next.activeRoutingPolicyGroup = activeGroupId;
    next.routingPolicyGroups = serializeRoutingGroups(groups);
    return next;
  });
}

function parseRouteTargetWithProviderCatalog(
  target: string,
  providerIds: Iterable<string>
): { providerId: string; modelId: string | null } {
  const trimmed = target.trim();
  if (!trimmed) {
    return { providerId: '', modelId: null };
  }

  let bestProvider: string | null = null;
  for (const providerId of providerIds) {
    const pid = providerId.trim();
    if (!pid) continue;
    if (trimmed === pid || trimmed.startsWith(`${pid}.`)) {
      if (!bestProvider || pid.length > bestProvider.length) {
        bestProvider = pid;
      }
    }
  }
  if (bestProvider) {
    if (trimmed === bestProvider) {
      return { providerId: bestProvider, modelId: null };
    }
    const modelId = trimmed.slice(bestProvider.length + 1).trim();
    return { providerId: bestProvider, modelId: modelId || null };
  }

  const dot = trimmed.indexOf('.');
  if (dot <= 0) {
    return { providerId: trimmed, modelId: null };
  }
  return {
    providerId: trimmed.slice(0, dot).trim(),
    modelId: trimmed.slice(dot + 1).trim() || null
  };
}

function collectRouteTargets(policy: RoutingPolicyGroup): Array<{ routeName: string; target: string }> {
  const out: Array<{ routeName: string; target: string }> = [];
  const routing = asRecord(policy.routing) ?? {};
  for (const [routeName, poolsNode] of Object.entries(routing)) {
    if (!Array.isArray(poolsNode)) continue;
    for (const pool of poolsNode) {
      const poolRow = asRecord(pool);
      if (!poolRow) continue;
      const targets = Array.isArray(poolRow.targets) ? poolRow.targets : [];
      for (const target of targets) {
        if (typeof target === 'string' && target.trim()) {
          out.push({ routeName, target: target.trim() });
        }
      }
      const lb = asRecord(poolRow.loadBalancing);
      const weights = lb ? asRecord(lb.weights) : null;
      if (weights) {
        for (const weightTarget of Object.keys(weights)) {
          if (weightTarget.trim()) {
            out.push({ routeName, target: weightTarget.trim() });
          }
        }
      }
    }
  }
  return out;
}

async function validateRoutingGroupAgainstProviders(
  policy: RoutingPolicyGroup,
  loadProviders: () => Promise<Record<string, { provider: Record<string, unknown> }>>
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const providerConfigs = await loadProviders();
  const providerModels = new Map<string, Set<string>>();
  for (const [providerId, cfg] of Object.entries(providerConfigs)) {
    const modelsNode = asRecord(cfg.provider)?.models;
    const set = new Set<string>();
    if (Array.isArray(modelsNode)) {
      for (const row of modelsNode) {
        const rowRecord = asRecord(row);
        const id = typeof rowRecord?.id === 'string' ? rowRecord.id.trim() : '';
        if (id) set.add(id);
      }
    } else {
      const asModelsRecord = asRecord(modelsNode);
      if (asModelsRecord) {
        for (const modelId of Object.keys(asModelsRecord)) {
          if (modelId.trim()) set.add(modelId.trim());
        }
      }
    }
    providerModels.set(providerId, set);
  }

  const errors: string[] = [];
  const targets = collectRouteTargets(policy);
  const seenTargets = new Set<string>();
  for (const item of targets) {
    const dedupKey = `${item.routeName}::${item.target}`;
    if (seenTargets.has(dedupKey)) continue;
    seenTargets.add(dedupKey);
    const { providerId, modelId } = parseRouteTargetWithProviderCatalog(item.target, providerModels.keys());
    if (!providerId) {
      errors.push(`route "${item.routeName}" has empty target "${item.target}"`);
      continue;
    }
    const modelSet = providerModels.get(providerId);
    if (!modelSet) {
      errors.push(`route "${item.routeName}" target "${item.target}" references missing provider "${providerId}"`);
      continue;
    }
    if (modelId && !modelSet.has(modelId)) {
      errors.push(
        `route "${item.routeName}" target "${item.target}" references missing model "${modelId}" in provider "${providerId}"`
      );
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }
  return { ok: true };
}

function parsePort(value: unknown): number | null {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function buildInteractivePrompt(
  ctx: ConfigCommandContext
): { prompt: (question: string) => Promise<string>; close: () => void } | null {
  if (typeof ctx.prompt === 'function') {
    return { prompt: ctx.prompt, close: () => {} };
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

export function createConfigCommand(program: Command, ctx: ConfigCommandContext): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const env = ctx.env ?? process.env;
  const log = ctx.log ?? ((line: string) => console.log(line));
  const spawnImpl = ctx.spawnImpl ?? spawn;
  const loadProviders = ctx.loadProviderConfigsV2 ?? (async () => await loadProviderConfigsV2());
  const bin = typeof (program as unknown as { name?: () => string }).name === 'function' ? program.name() : 'rcc';

  program
    .command('config')
    .description('Configuration management')
    .addHelpText(
      'after',
      `
Tips:
  - Prefer "${bin} init" for guided config generation.

Examples:
  ${bin} init
  ${bin} config show
  ${bin} config validate
  ${bin} config group-list
  ${bin} config switch-group --group default --port 5555
  ${bin} config init --providers openai,qwen --default-provider qwen
`
    )
    .argument('<action>', 'Action to perform (show, edit, validate, init)')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-t, --template <template>', 'Init template provider id (e.g., openai, responses, qwen, iflow)')
    .option('--providers <ids>', 'Init providers (comma-separated), e.g. openai,qwen,iflow')
    .option('--default-provider <id>', 'Init default provider id for routing.default')
    .option('--host <host>', 'Init server host (httpserver.host)')
    .option('--port <port>', 'Init server port (httpserver.port)')
    .option('--group <id>', 'Routing policy group id for group actions')
    .option('--reload', 'Signal running server (SIGUSR2) after switch (default: true)', true)
    .option('--no-reload', 'Do not signal running server after switch')
    .option('-f, --force', 'Force overwrite existing configuration')
    .action(async (action: string, options: { config?: string; template?: string; providers?: string; defaultProvider?: string; host?: string; port?: string; group?: string; reload?: boolean; force?: boolean }) => {
      try {
        const configPath = options.config || resolveRccConfigFile(home());

        switch (action) {
          case 'init':
            {
              const spinner = await ctx.createSpinner('Initializing configuration...');
              const catalog = getBootstrapProviderTemplates();
              const supported = catalog.map((p) => p.id).join(', ');
              const providersFromArg =
                parseProvidersArg(options.providers) ??
                (typeof options.template === 'string' && options.template.trim() ? [options.template.trim()] : undefined);

              // `config init` is intentionally non-interactive (use `${bin} init` for guided generation).
              // This keeps CLI behavior deterministic in CI/tests and avoids hanging on readline prompts.
              if (!providersFromArg || providersFromArg.length === 0) {
                spinner.fail('Failed to initialize configuration');
                ctx.logger.error(`Non-interactive init requires --providers or --template. Supported: ${supported}`);
                return;
              }
              const result = await initializeConfigV1(
                {
                  fsImpl,
                  pathImpl
                },
                {
                  configPath,
                  force: Boolean(options.force),
                  host: options.host,
                  port:
                    typeof options.port === 'string' && Number.isFinite(Number(options.port)) && Number(options.port) > 0
                      ? Math.floor(Number(options.port))
                      : undefined,
                  providers: providersFromArg,
                  defaultProvider: options.defaultProvider
                },
                undefined
              );

              if (!result.ok) {
                spinner.fail('Failed to initialize configuration');
                ctx.logger.error(result.message);
                return;
              }

              spinner.succeed(`Configuration initialized: ${result.configPath}`);
              if (result.backupPath) {
                ctx.logger.info(`Backed up existing config: ${result.backupPath}`);
              }
              ctx.logger.info(`Providers: ${result.selectedProviders.join(', ')}`);
              ctx.logger.info(`Default provider: ${result.defaultProvider}`);
              {
                const installed = installBundledDocsBestEffort({ fsImpl, pathImpl });
                if (installed.ok) {
                  ctx.logger.info(`Docs installed: ${installed.targetDir}`);
                }
              }
              ctx.logger.info('Next: edit apiKey/tokenFile/cookieFile as needed, then run: rcc start');
            }
            break;
          case 'show':
            if (fsImpl.existsSync(configPath)) {
              const config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
              log(JSON.stringify(config, null, 2));
            } else {
              ctx.logger.error('Configuration file not found');
            }
            break;
          case 'group-list':
          case 'groups':
            {
              if (!fsImpl.existsSync(configPath)) {
                ctx.logger.error('Configuration file not found');
                break;
              }
              const parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
              const snapshot = extractRoutingGroupsSnapshot(parsed);
              const ids = Object.keys(snapshot.groups).sort((a, b) => a.localeCompare(b));
              if (!ids.length) {
                ctx.logger.error('No routing policy groups found');
                break;
              }
              for (const id of ids) {
                const mark = id === snapshot.activeGroupId ? '*' : ' ';
                const routeCount = Object.keys(asRecord(snapshot.groups[id].routing) ?? {}).length;
                log(`${mark} ${id}  (routes=${routeCount})`);
              }
            }
            break;
          case 'group-current':
          case 'current-group':
            {
              if (!fsImpl.existsSync(configPath)) {
                ctx.logger.error('Configuration file not found');
                break;
              }
              const parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
              const snapshot = extractRoutingGroupsSnapshot(parsed);
              log(snapshot.activeGroupId);
            }
            break;
          case 'group-validate':
          case 'validate-group':
            {
              if (!fsImpl.existsSync(configPath)) {
                ctx.logger.error('Configuration file not found');
                break;
              }
              const groupId = (options.group || '').trim();
              if (!groupId) {
                ctx.logger.error('Missing --group <id>');
                break;
              }
              const parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
              const snapshot = extractRoutingGroupsSnapshot(parsed);
              const policy = snapshot.groups[groupId];
              if (!policy) {
                ctx.logger.error(`Group not found: ${groupId}`);
                break;
              }
              const validation = await validateRoutingGroupAgainstProviders(policy, loadProviders);
              if (!validation.ok) {
                ctx.logger.error(`Group validation failed: ${groupId}`);
                for (const err of validation.errors) {
                  ctx.logger.error(`- ${err}`);
                }
                break;
              }
              ctx.logger.success(`Group is valid: ${groupId}`);
            }
            break;
          case 'switch-group':
          case 'group-switch':
            {
              if (!fsImpl.existsSync(configPath)) {
                ctx.logger.error('Configuration file not found');
                break;
              }
              const groupId = (options.group || '').trim();
              if (!groupId) {
                ctx.logger.error('Missing --group <id>');
                break;
              }
              const parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
              const snapshot = extractRoutingGroupsSnapshot(parsed);
              const policy = snapshot.groups[groupId];
              if (!policy) {
                ctx.logger.error(`Group not found: ${groupId}`);
                break;
              }
              const validation = await validateRoutingGroupAgainstProviders(policy, loadProviders);
              if (!validation.ok) {
                ctx.logger.error(`Switch blocked: group "${groupId}" is invalid`);
                for (const err of validation.errors) {
                  ctx.logger.error(`- ${err}`);
                }
                break;
              }

              const next = applyRoutingGroupsIntoConfig(parsed, snapshot.groups, groupId);
              fsImpl.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
              ctx.logger.success(`Switched active routing group: ${snapshot.activeGroupId} -> ${groupId}`);

              if (options.reload !== false) {
                const resolvedPort =
                  parsePort(options.port)
                  ?? parsePort((asRecord(next.httpserver) ?? {}).port)
                  ?? null;
                if (!resolvedPort) {
                  ctx.logger.warning('Reload skipped: no --port and no valid httpserver.port found');
                  break;
                }
                if (typeof ctx.findListeningPids !== 'function' || typeof ctx.sendSignal !== 'function') {
                  ctx.logger.warning(`Reload skipped: no process signal capability in this CLI context (target port=${resolvedPort})`);
                  break;
                }
                const pids = ctx.findListeningPids(resolvedPort);
                if (!Array.isArray(pids) || pids.length === 0) {
                  ctx.logger.warning(`Reload skipped: no running RouteCodex process found on port ${resolvedPort}`);
                  break;
                }
                for (const pid of pids) {
                  ctx.sendSignal(pid, 'SIGUSR2');
                }
                ctx.logger.info(`Reload signal sent (SIGUSR2) on port ${resolvedPort}: pid=${pids.join(',')}`);
              }
            }
            break;
          case 'edit': {
            const editor = env.EDITOR || 'nano';
            spawnImpl(editor, [configPath], { stdio: 'inherit' });
            break;
          }
          case 'validate': {
            if (fsImpl.existsSync(configPath)) {
              try {
                JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
                ctx.logger.success('Configuration is valid');
              } catch (error) {
                ctx.logger.error(`Configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
              }
            } else {
              ctx.logger.error('Configuration file not found');
            }
            break;
          }
          default:
            ctx.logger.error('Unknown action. Use: show, edit, validate, init, group-list, group-current, group-validate, switch-group');
        }
      } catch (error) {
        ctx.logger.error(`Config command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}
