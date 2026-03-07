import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

import { getInitProviderCatalogEntry, type ProviderCatalogSdkBinding } from '../cli/config/init-provider-catalog.js';
import { TokenFileAuthProvider } from '../providers/auth/tokenfile-auth.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';

export type ProviderDoctorResult = {
  ok: boolean;
  providerId: string;
  modelId: string;
  binding: ProviderCatalogSdkBinding;
  baseURL?: string;
  message: string;
  text?: string;
  usage?: unknown;
};

export type ProviderDoctorInput = {
  providerId: string;
  providerNode: UnknownRecord;
  modelId: string;
  prompt?: string;
};

export type ProviderDoctorDeps = {
  executeProbe?: (args: {
    binding: ProviderCatalogSdkBinding;
    apiKey: string;
    baseURL: string;
    modelId: string;
    headers: Record<string, string>;
    prompt: string;
  }) => Promise<{ text: string; usage?: unknown }>;
};

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveSecretValue(raw: unknown): string {
  const trimmed = normalizeString(raw);
  if (!trimmed) {
    return '';
  }
  const envMatch = trimmed.match(/^\$\{([A-Z0-9_]+)(?::-[^}]*)?\}$/i);
  if (envMatch) {
    return normalizeString(process.env[envMatch[1]]);
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return normalizeString(process.env[trimmed]);
  }
  return trimmed;
}

function resolveProviderBinding(providerId: string, providerNode: UnknownRecord): ProviderCatalogSdkBinding {
  const catalogEntry = getInitProviderCatalogEntry(providerId);
  if (catalogEntry?.sdkBinding) {
    return catalogEntry.sdkBinding;
  }
  const providerType = normalizeString(providerNode.type).toLowerCase();
  if (providerType === 'anthropic') {
    return { family: 'anthropic-compatible', supported: true };
  }
  if (providerType === 'openai' || providerType === 'responses') {
    return { family: 'openai-compatible', supported: true };
  }
  return {
    family: 'custom-runtime',
    supported: false,
    notes: `Provider type "${providerType || providerId}" requires the existing RouteCodex runtime path.`
  };
}

function extractBearerToken(headers: Record<string, string>): string {
  const authorization = headers.Authorization || headers.authorization || '';
  const matched = authorization.match(/^Bearer\s+(.+)$/i);
  return matched ? normalizeString(matched[1]) : '';
}

async function resolveAuthHeaders(providerId: string, providerNode: UnknownRecord): Promise<Record<string, string>> {
  const authNode = isRecord(providerNode.auth) ? providerNode.auth : {};
  const authType = normalizeString(authNode.type).toLowerCase();

  if (authType.includes('oauth')) {
    const oauthProvider = new TokenFileAuthProvider({
      ...(authNode as Record<string, unknown>),
      oauthProviderId: authType.replace(/-oauth$/, '') || providerId,
      type: authType || 'oauth'
    } as any);
    await oauthProvider.initialize();
    return oauthProvider.buildHeaders();
  }

  const entries = Array.isArray(authNode.entries) ? authNode.entries.filter((entry) => isRecord(entry)) as UnknownRecord[] : [];
  const firstEntry = entries[0] || {};
  const apiKey = resolveSecretValue(firstEntry.apiKey ?? authNode.apiKey ?? firstEntry.env ?? authNode.env);
  if (!apiKey) {
    return {};
  }
  const headerName = normalizeString(firstEntry.headerName ?? authNode.headerName) || 'Authorization';
  const prefix = normalizeString(firstEntry.prefix ?? authNode.prefix) || 'Bearer';
  const headerValue = prefix.toLowerCase() === 'bearer' ? `Bearer ${apiKey}` : `${prefix} ${apiKey}`.trim();
  return { [headerName]: headerValue };
}

const defaultExecuteProbe: NonNullable<ProviderDoctorDeps['executeProbe']> = async ({
  binding,
  apiKey,
  baseURL,
  modelId,
  headers,
  prompt
}) => {
  const provider = binding.family === 'anthropic-compatible'
    ? createAnthropic({ apiKey, baseURL, headers })
    : createOpenAI({ apiKey, baseURL, headers });
  const result = await generateText({
    model: provider(modelId),
    prompt,
    maxOutputTokens: 64
  });
  return {
    text: result.text,
    usage: result.usage
  };
};

export async function runVercelAiProviderDoctor(
  input: ProviderDoctorInput,
  deps: ProviderDoctorDeps = {}
): Promise<ProviderDoctorResult> {
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  const providerNode = input.providerNode;
  const binding = resolveProviderBinding(providerId, providerNode);
  const baseURL = normalizeString(providerNode.baseURL ?? providerNode.baseUrl);

  if (!binding.supported) {
    return {
      ok: false,
      providerId,
      modelId,
      binding,
      baseURL,
      message: binding.notes || 'Provider is not directly probeable with the Vercel AI SDK.'
    };
  }
  if (!baseURL) {
    return {
      ok: false,
      providerId,
      modelId,
      binding,
      message: 'Provider is missing baseURL/baseUrl.'
    };
  }

  const authHeaders = await resolveAuthHeaders(providerId, providerNode);
  const apiKey = extractBearerToken(authHeaders);
  if (!apiKey) {
    return {
      ok: false,
      providerId,
      modelId,
      binding,
      baseURL,
      message: 'Unable to resolve a Bearer credential from provider.auth for Vercel AI SDK probing.'
    };
  }

  const staticHeaders = isRecord(providerNode.headers)
    ? Object.fromEntries(
        Object.entries(providerNode.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : {};
  const prompt = input.prompt?.trim() || 'Reply with exactly OK.';
  const executeProbe = deps.executeProbe || defaultExecuteProbe;

  try {
    const result = await executeProbe({
      binding,
      apiKey,
      baseURL,
      modelId,
      headers: { ...staticHeaders, ...authHeaders },
      prompt
    });
    return {
      ok: true,
      providerId,
      modelId,
      binding,
      baseURL,
      message: 'Vercel AI SDK probe succeeded.',
      text: result.text,
      usage: result.usage
    };
  } catch (error) {
    return {
      ok: false,
      providerId,
      modelId,
      binding,
      baseURL,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
