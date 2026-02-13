import type { InitProviderTemplate } from '../../config/init-provider-catalog.js';
import { CUSTOM_PROTOCOL_PRESETS, type LoggerLike, type PromptLike, type RoutingConfig, type UnknownRecord } from './shared.js';
import {
  buildRouting,
  isBackInput,
  normalizeEnvVarName,
  normalizeHost,
  normalizePort,
  readPrimaryTargetFromRoute
} from './basic.js';

export async function interactiveCreateCustomProvider(
  prompt: PromptLike,
  existingProviderIds: Set<string>,
  logger: LoggerLike
): Promise<{ providerId: string; providerNode: UnknownRecord } | null> {
  const providerId = (await prompt('Custom provider id (e.g. myprovider, b=back):\n> ')).trim();
  if (isBackInput(providerId)) {
    logger.info('Back to add-provider menu.');
    return null;
  }
  if (!providerId) {
    logger.info('Custom provider creation cancelled (empty provider id).');
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(providerId)) {
    logger.info('Invalid provider id. Use only letters, numbers, dot, underscore, dash.');
    return null;
  }
  if (existingProviderIds.has(providerId)) {
    logger.info(`Provider ${providerId} already exists.`);
    return null;
  }

  const protocolLines = CUSTOM_PROTOCOL_PRESETS.map((preset) => `  ${preset.id}) ${preset.label}`);
  let protocol = undefined as (typeof CUSTOM_PROTOCOL_PRESETS)[number] | undefined;
  while (!protocol) {
    const protocolPick = (await prompt(`Select protocol (b=back):\n${protocolLines.join('\n')}\n> `)).trim();
    if (isBackInput(protocolPick)) {
      logger.info('Back to add-provider menu.');
      return null;
    }
    if (!protocolPick) {
      protocol = CUSTOM_PROTOCOL_PRESETS[0];
      break;
    }
    protocol = CUSTOM_PROTOCOL_PRESETS.find((preset) => preset.id === protocolPick);
    if (!protocol) {
      logger.info('Invalid protocol choice. Select 1/2/3/4.');
    }
  }

  const defaultBase =
    protocol.providerType === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : protocol.providerType === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : 'https://api.example.com/v1';
  const baseURLInput = (await prompt(`Base URL (default=${defaultBase}, b=back):\n> `)).trim();
  if (isBackInput(baseURLInput)) {
    logger.info('Back to add-provider menu.');
    return null;
  }
  const baseURL = baseURLInput || defaultBase;

  const modelIdInput = (await prompt('Default model id (e.g. gpt-5.2, b=back):\n> ')).trim();
  if (isBackInput(modelIdInput)) {
    logger.info('Back to add-provider menu.');
    return null;
  }
  const modelId = modelIdInput || 'default-model';
  const defaultEnvVar = normalizeEnvVarName(providerId);
  const envVarInput = (await prompt(`API key env var (default=${defaultEnvVar}, b=back):\n> `)).trim();
  if (isBackInput(envVarInput)) {
    logger.info('Back to add-provider menu.');
    return null;
  }
  const envVar = envVarInput || defaultEnvVar;

  const providerNode: UnknownRecord = {
    id: providerId,
    enabled: true,
    type: protocol.providerType,
    baseURL,
    auth: {
      type: 'apikey',
      apiKey: `\${${envVar}}`
    },
    models: {
      [modelId]: { supportsStreaming: true }
    }
  };

  if (protocol.providerType === 'responses') {
    providerNode.responses = { process: 'chat', streaming: 'always' };
    providerNode.config = { responses: { streaming: 'always' } };
  }

  return { providerId, providerNode };
}

export async function promptYesNo(prompt: PromptLike, question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answerRaw = await prompt(`${question} (${suffix})\n> `);
  const answer = String(answerRaw ?? '').trim().toLowerCase();
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

export async function interactiveSelectProviders(
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

export async function interactivePickDefaultProvider(
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

export async function interactiveHostPort(
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

export function isValidTargetFormat(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) {
    return false;
  }
  const dotIndex = trimmed.indexOf('.');
  return dotIndex > 0 && dotIndex < trimmed.length - 1;
}

export async function interactiveRoutingWizard(
  prompt: PromptLike,
  existingRouting: RoutingConfig,
  defaultTarget: string
): Promise<RoutingConfig | null> {
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

    if (isBackInput(answer)) {
      if (index === 0) {
        return null;
      }
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
    const answer = (await prompt(`Routing summary: ${summary}\nType route key to edit, 'save' to continue, 'b' to cancel\n> `))
      .trim()
      .toLowerCase();
    if (isBackInput(answer)) {
      return null;
    }
    if (!answer || answer === 'save') {
      break;
    }
    if ((keys as string[]).includes(answer)) {
      const key = answer as 'default' | 'thinking' | 'tools';
      const edit = (await prompt(`New target for ${key} (provider.model), current=${targets[key]}, b=back\n> `)).trim();
      if (isBackInput(edit)) {
        continue;
      }
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
