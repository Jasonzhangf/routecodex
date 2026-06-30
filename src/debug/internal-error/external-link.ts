export type ExternalErrorLinkKind = 'provider' | 'upstream' | 'client' | 'transport';

export interface ExternalErrorLink {
  kind: ExternalErrorLinkKind;
  status?: number;
  code?: string;
  providerKey?: string;
  upstreamRequestId?: string;
  message?: string;
}

export function linkExternalError(link: ExternalErrorLink): ExternalErrorLink {
  if (!link || typeof link !== 'object') {
    throw new Error('external error link must be an object');
  }
  if (!['provider', 'upstream', 'client', 'transport'].includes(link.kind)) {
    throw new Error(`invalid external error link kind: ${String((link as { kind?: unknown }).kind)}`);
  }
  return {
    kind: link.kind,
    ...(typeof link.status === 'number' ? { status: link.status } : {}),
    ...(typeof link.code === 'string' && link.code.trim() ? { code: link.code.trim() } : {}),
    ...(typeof link.providerKey === 'string' && link.providerKey.trim() ? { providerKey: link.providerKey.trim() } : {}),
    ...(typeof link.upstreamRequestId === 'string' && link.upstreamRequestId.trim() ? { upstreamRequestId: link.upstreamRequestId.trim() } : {}),
    ...(typeof link.message === 'string' && link.message.trim() ? { message: link.message.trim() } : {}),
  };
}
