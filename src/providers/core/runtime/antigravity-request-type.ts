import type { UnknownObject } from '../../../types/common-types.js';

const NETWORKING_TOOL_KEYWORDS = new Set([
  'web_search',
  'web_search_20250305',
  'websearch',
  'google_search',
  'google_search_retrieval'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function readExplicitRequestType(record: Record<string, unknown>): string | undefined {
  const raw = readNonEmptyString(record.requestType);
  if (!raw) {
    return undefined;
  }
  const normalized = raw.toLowerCase();
  if (normalized === 'agent' || normalized === 'web_search' || normalized === 'image_gen') {
    return normalized;
  }
  return undefined;
}

function readMetadataHasImageAttachment(record: Record<string, unknown>): boolean {
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  if (!metadata) {
    return false;
  }
  return metadata.hasImageAttachment === true || metadata.hasImageAttachment === 'true';
}

function readModel(record: Record<string, unknown>): string | undefined {
  const direct = readNonEmptyString(record.model);
  if (direct) {
    return direct;
  }
  const nestedRequest = isRecord(record.request) ? record.request : undefined;
  if (!nestedRequest) {
    return undefined;
  }
  return readNonEmptyString(nestedRequest.model);
}

function collectTools(record: Record<string, unknown>): unknown[] {
  const collected: unknown[] = [];
  if (Array.isArray(record.tools)) {
    collected.push(...record.tools);
  }
  const nestedRequest = isRecord(record.request) ? record.request : undefined;
  if (nestedRequest && Array.isArray(nestedRequest.tools)) {
    collected.push(...nestedRequest.tools);
  }
  return collected;
}

function isNetworkingToolName(raw: unknown): boolean {
  const normalized = readNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return NETWORKING_TOOL_KEYWORDS.has(normalized);
}

function hasNetworkingTool(tools: unknown[]): boolean {
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    if (isNetworkingToolName(tool.name) || isNetworkingToolName(tool.type)) {
      return true;
    }

    const fn = isRecord(tool.function) ? tool.function : undefined;
    if (fn && isNetworkingToolName(fn.name)) {
      return true;
    }

    const declarations = Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : undefined;
    if (declarations) {
      for (const declaration of declarations) {
        if (isRecord(declaration) && isNetworkingToolName(declaration.name)) {
          return true;
        }
      }
    }

    if (isRecord(tool.googleSearch) || isRecord(tool.googleSearchRetrieval)) {
      return true;
    }
  }
  return false;
}

function isImageModel(model: string | undefined): boolean {
  const normalized = readNonEmptyString(model)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.startsWith('gemini-3-pro-image') || normalized.includes('gemini-3-pro-image');
}

function hasOnlineSuffix(model: string | undefined): boolean {
  const normalized = readNonEmptyString(model)?.toLowerCase();
  return !!normalized && normalized.endsWith('-online');
}

export function resolveAntigravityRequestTypeFromPayload(request: UnknownObject | Record<string, unknown> | unknown): 'agent' | 'web_search' | 'image_gen' {
  if (!isRecord(request)) {
    return 'agent';
  }

  const root = request;
  const envelope = isRecord(root.data) ? (root.data as Record<string, unknown>) : root;

  const explicit = readExplicitRequestType(envelope) || readExplicitRequestType(root);
  if (explicit === 'agent' || explicit === 'web_search' || explicit === 'image_gen') {
    return explicit;
  }

  const model = readModel(envelope) || readModel(root);
  if (isImageModel(model)) {
    return 'image_gen';
  }

  const tools = [...collectTools(envelope), ...collectTools(root)];
  if (hasOnlineSuffix(model) || hasNetworkingTool(tools)) {
    return 'web_search';
  }

  const hasImageAttachment =
    readMetadataHasImageAttachment(envelope) || readMetadataHasImageAttachment(root);
  if (hasImageAttachment) {
    return 'image_gen';
  }

  return 'agent';
}
