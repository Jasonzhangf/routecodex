import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';

import {
  asArray,
  asRecord,
  pickBoolean,
  pickNumber,
  pickString,
  type UnknownRecord
} from './anthropic-sdk-transport-shared.js';

type AnthropicProviderOptions = Record<string, unknown>;

export function convertAnthropicProviderOptions(rawBody: UnknownRecord): AnthropicProviderOptions | undefined {
  const thinking = asRecord(rawBody.thinking);
  const outputConfig = asRecord(rawBody.output_config ?? rawBody.outputConfig);
  const providerOptions: AnthropicProviderOptions = {};

  const thinkingType = pickString(thinking.type);
  if (thinkingType === 'adaptive') {
    providerOptions.thinking = { type: 'adaptive' };
  } else if (thinkingType === 'enabled') {
    providerOptions.thinking = {
      type: 'enabled',
      ...(pickNumber(thinking.budget_tokens ?? thinking.budgetTokens) !== undefined
        ? { budgetTokens: pickNumber(thinking.budget_tokens ?? thinking.budgetTokens) }
        : {})
    };
  } else if (thinkingType === 'disabled') {
    providerOptions.thinking = { type: 'disabled' };
  }

  const effort = pickString(outputConfig.effort);
  if (effort && ['low', 'medium', 'high', 'max'].includes(effort)) {
    providerOptions.effort = effort;
  }

  const speed = pickString(rawBody.speed);
  if (speed && ['fast', 'standard'].includes(speed)) {
    providerOptions.speed = speed;
  }

  const disableParallelToolUse = pickBoolean(
    rawBody.disable_parallel_tool_use ?? rawBody.disableParallelToolUse ?? asRecord(rawBody.tool_choice).disable_parallel_tool_use
  );
  if (disableParallelToolUse !== undefined) {
    providerOptions.disableParallelToolUse = disableParallelToolUse;
  }

  const container = rawBody.container;
  if (typeof container === 'string') {
    providerOptions.container = { id: container };
  } else if (container && typeof container === 'object' && !Array.isArray(container)) {
    const containerBag = asRecord(container);
    const id = pickString(containerBag.id);
    const skills = asArray(containerBag.skills)
      .map((entry) => asRecord(entry))
      .map((entry) => {
        const type = pickString(entry.type);
        const skillId = pickString(entry.skill_id ?? entry.skillId);
        if (!type || !skillId) {
          return null;
        }
        return {
          type: type === 'custom' ? 'custom' : 'anthropic',
          skillId,
          ...(pickString(entry.version) ? { version: pickString(entry.version) } : {})
        };
      })
      .filter(Boolean);
    if (id || skills.length > 0) {
      providerOptions.container = {
        ...(id ? { id } : {}),
        ...(skills.length > 0 ? { skills: skills as Array<Record<string, unknown>> } : {})
      };
    }
  }

  const mcpServers = asArray(rawBody.mcp_servers ?? rawBody.mcpServers)
    .map((entry) => asRecord(entry))
    .map((entry) => {
      const type = pickString(entry.type);
      const name = pickString(entry.name);
      const url = pickString(entry.url);
      if (type !== 'url' || !name || !url) {
        return null;
      }
      const toolConfiguration = asRecord(entry.tool_configuration ?? entry.toolConfiguration);
      return {
        type: 'url' as const,
        name,
        url,
        authorizationToken: pickString(entry.authorization_token ?? entry.authorizationToken) ?? null,
        ...(Object.keys(toolConfiguration).length > 0
          ? {
              toolConfiguration: {
                ...(pickBoolean(toolConfiguration.enabled) !== undefined
                  ? { enabled: pickBoolean(toolConfiguration.enabled) }
                  : {}),
                ...(Array.isArray(toolConfiguration.allowed_tools ?? toolConfiguration.allowedTools)
                  ? { allowedTools: asArray(toolConfiguration.allowed_tools ?? toolConfiguration.allowedTools).map(String) }
                  : {})
              }
            }
          : {})
      };
    })
    .filter(Boolean);
  if (mcpServers.length > 0) {
    providerOptions.mcpServers = mcpServers;
  }

  const contextManagement = asRecord(rawBody.context_management ?? rawBody.contextManagement);
  const edits = asArray(contextManagement.edits)
    .map((entry) => asRecord(entry))
    .map((entry) => {
      const type = pickString(entry.type);
      if (!type) {
        return null;
      }
      if (type === 'clear_tool_uses_20250919') {
        return {
          type,
          ...(entry.trigger && typeof entry.trigger === 'object' ? { trigger: entry.trigger } : {}),
          ...(entry.keep && typeof entry.keep === 'object' ? { keep: entry.keep } : {}),
          ...(entry.clear_at_least && typeof entry.clear_at_least === 'object'
            ? { clearAtLeast: entry.clear_at_least }
            : entry.clearAtLeast && typeof entry.clearAtLeast === 'object'
              ? { clearAtLeast: entry.clearAtLeast }
              : {}),
          ...(pickBoolean(entry.clear_tool_inputs ?? entry.clearToolInputs) !== undefined
            ? { clearToolInputs: pickBoolean(entry.clear_tool_inputs ?? entry.clearToolInputs) }
            : {}),
          ...(Array.isArray(entry.exclude_tools ?? entry.excludeTools)
            ? { excludeTools: asArray(entry.exclude_tools ?? entry.excludeTools).map(String) }
            : {})
        };
      }
      if (type === 'clear_thinking_20251015') {
        return {
          type,
          ...(entry.keep !== undefined ? { keep: entry.keep } : {})
        };
      }
      if (type === 'compact_20260112') {
        return {
          type,
          ...(entry.trigger && typeof entry.trigger === 'object' ? { trigger: entry.trigger } : {}),
          ...(pickBoolean(entry.pause_after_compaction ?? entry.pauseAfterCompaction) !== undefined
            ? { pauseAfterCompaction: pickBoolean(entry.pause_after_compaction ?? entry.pauseAfterCompaction) }
            : {}),
          ...(pickString(entry.instructions) ? { instructions: pickString(entry.instructions) } : {})
        };
      }
      return null;
    })
    .filter(Boolean);
  if (edits.length > 0) {
    providerOptions.contextManagement = { edits };
  }

  return Object.keys(providerOptions).length ? providerOptions : undefined;
}

export function convertAnthropicResponseFormat(rawBody: UnknownRecord): LanguageModelV3CallOptions['responseFormat'] | undefined {
  const outputConfig = asRecord(rawBody.output_config ?? rawBody.outputConfig);
  const format = asRecord(outputConfig.format);
  const type = pickString(format.type)?.toLowerCase();
  if (type !== 'json_schema') {
    return undefined;
  }
  const schema = format.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  return {
    type: 'json',
    schema: schema as Record<string, unknown>,
    ...(pickString(format.name) ? { name: pickString(format.name) } : {}),
    ...(pickString(format.description) ? { description: pickString(format.description) } : {})
  };
}
