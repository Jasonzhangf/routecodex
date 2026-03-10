import type { RouterMetadataInput, RoutingInstructionMode } from '../../types.js';
import type { RoutingInstruction, RoutingInstructionState } from '../../routing-instructions.js';

export function buildMetadataInstructions(
  metadata: RouterMetadataInput,
  options?: {
    forcedProviderKeyField?: string;
  }
): RoutingInstruction[] {
  const instructions: RoutingInstruction[] = [];
  const forcedField = options?.forcedProviderKeyField || '__shadowCompareForcedProviderKey';
  const forcedProviderKeyRaw = (metadata as unknown as Record<string, unknown>)[forcedField];
  const forcedProviderKey = parseMetadataForceProviderKey(forcedProviderKeyRaw);
  if (forcedProviderKey) {
    instructions.push({ type: 'force', ...forcedProviderKey });
  }
  if (Array.isArray((metadata as any).disabledProviderKeyAliases)) {
    for (const entry of (metadata as any).disabledProviderKeyAliases) {
      const parsed = parseMetadataDisableDescriptor(entry);
      if (parsed) {
        instructions.push({ type: 'disable', ...parsed });
      }
    }
  }
  return instructions;
}

export function resolveRoutingMode(
  instructions: RoutingInstruction[],
  state: RoutingInstructionState
): RoutingInstructionMode {
  const hasForce = instructions.some((inst) => inst.type === 'force');
  const hasAllow = instructions.some((inst) => inst.type === 'allow');
  const hasClear = instructions.some((inst) => inst.type === 'clear');
  const hasPrefer = instructions.some((inst) => inst.type === 'prefer');

  if (hasClear) {
    return 'none';
  }
  if (hasAllow || state.allowedProviders.size > 0) {
    return 'sticky';
  }
  if (hasForce || state.forcedTarget) {
    return 'force';
  }
  if (hasPrefer || state.preferTarget) {
    return 'sticky';
  }
  if (state.stickyTarget) {
    return 'sticky';
  }
  return 'none';
}

function parseMetadataDisableDescriptor(entry: unknown): {
  provider?: string;
  keyAlias?: string;
  keyIndex?: number;
} | null {
  if (typeof entry !== 'string') {
    return null;
  }
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split('.');
  if (parts.length < 2) {
    return null;
  }
  const provider = parts[0];
  const alias = parts[1];
  if (!provider || !alias) {
    return null;
  }
  if (/^\d+$/.test(alias)) {
    return { provider, keyIndex: Number.parseInt(alias, 10) };
  }
  return { provider, keyAlias: alias };
}

function parseMetadataForceProviderKey(entry: unknown): {
  provider?: string;
  keyAlias?: string;
  keyIndex?: number;
  model?: string;
  pathLength?: number;
} | null {
  if (typeof entry !== 'string') {
    return null;
  }
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }

  // Accept the bracket notation used in virtual-router-hit logs: provider[alias].model
  // - provider[].model means provider.model across all aliases
  const bracketMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]*)\](?:\.(.+))?$/);
  if (bracketMatch) {
    const provider = bracketMatch[1]?.trim() || '';
    const keyAlias = bracketMatch[2]?.trim() || '';
    const model = typeof bracketMatch[3] === 'string' ? bracketMatch[3].trim() : '';
    if (!provider) {
      return null;
    }
    if (keyAlias) {
      return {
        provider,
        keyAlias,
        ...(model ? { model } : {}),
        pathLength: 3
      };
    }
    if (model) {
      return {
        provider,
        model,
        pathLength: 2
      };
    }
    return { provider, pathLength: 1 };
  }

  // Accept provider.keyAlias.model and provider.model (model may contain dots when keyAlias is explicit).
  const parts = trimmed.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const provider = parts[0] || '';
  if (!provider) {
    return null;
  }
  if (parts.length === 1) {
    return { provider, pathLength: 1 };
  }
  if (parts.length === 2) {
    const second = parts[1] || '';
    if (!second) {
      return null;
    }
    if (/^\d+$/.test(second)) {
      const keyIndex = Number.parseInt(second, 10);
      return Number.isFinite(keyIndex) && keyIndex > 0 ? { provider, keyIndex, pathLength: 2 } : null;
    }
    return { provider, model: second, pathLength: 2 };
  }
  const keyAlias = parts[1] || '';
  const model = parts.slice(2).join('.').trim();
  if (!keyAlias) {
    return null;
  }
  return {
    provider,
    keyAlias,
    ...(model ? { model } : {}),
    pathLength: 3
  };
}
