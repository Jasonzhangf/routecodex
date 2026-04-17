const FOLLOWUP_SESSION_HEADER_KEYS = new Set([
  'sessionid',
  'conversationid',
  'xsessionid',
  'xconversationid',
  'anthropicsessionid',
  'anthropicconversationid',
  'xroutecodexsessionid',
  'xroutecodexconversationid',
  'xroutecodexclientdaemonid',
  'xroutecodexclientdid',
  'xrccclientdaemonid',
  'xroutecodexsessiondaemonid',
  'xroutecodexdaemonid',
  'xrccsessiondaemonid',
  'xroutecodexclienttmuxsessionid',
  'xrccclienttmuxsessionid',
  'xroutecodextmuxsessionid',
  'xrcctmuxsessionid',
  'xtmuxsessionid',
  'xroutecodexclientworkdir',
  'xrccclientworkdir',
  'xroutecodexworkdir',
  'xrccworkdir',
  'xworkdir'
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function cloneStringHeaders(headers: unknown): Record<string, string> | undefined {
  const source = asRecord(headers);
  if (!source) {
    return undefined;
  }
  const cloned: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(source)) {
    const normalizedValue = readNonEmptyString(headerValue);
    if (!normalizedValue) {
      continue;
    }
    cloned[headerName] = normalizedValue;
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function canonicalizeHeaderName(headerName: string): string {
  return headerName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractFollowupSessionHeaders(
  headers: unknown
): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }
  const source = headers as Record<string, unknown>;
  const preserved: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(source)) {
    if (!FOLLOWUP_SESSION_HEADER_KEYS.has(canonicalizeHeaderName(headerName))) {
      continue;
    }
    const normalizedValue = readNonEmptyString(headerValue);
    if (!normalizedValue) {
      continue;
    }
    preserved[headerName] = normalizedValue;
  }
  return Object.keys(preserved).length ? preserved : undefined;
}

function extractPreservedSessionToken(
  headers: Record<string, string> | undefined,
  field: 'session' | 'conversation'
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalizedName = canonicalizeHeaderName(headerName);
    if (field === 'session' && normalizedName.endsWith('sessionid')) {
      return headerValue;
    }
    if (field === 'conversation' && normalizedName.endsWith('conversationid')) {
      return headerValue;
    }
  }
  return undefined;
}

function extractPreservedInjectToken(
  headers: Record<string, string> | undefined,
  field: 'daemon' | 'tmux' | 'workdir'
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalizedName = canonicalizeHeaderName(headerName);
    if (field === 'daemon' && (normalizedName.endsWith('sessiondaemonid') || normalizedName.endsWith('daemonid'))) {
      return headerValue;
    }
    if (field === 'tmux' && normalizedName.endsWith('tmuxsessionid')) {
      return headerValue;
    }
    if (field === 'workdir' && normalizedName.endsWith('workdir')) {
      return headerValue;
    }
  }
  return undefined;
}

export function buildServerToolNestedRequestMetadata(args: {
  baseMetadata?: Record<string, unknown>;
  extraMetadata?: Record<string, unknown>;
  entryEndpoint: string;
  onMergeRuntimeMetaError?: (error: unknown) => void;
}): Record<string, unknown> {
  const baseMetadata = asRecord(args.baseMetadata) ?? {};
  const extraMetadata = asRecord(args.extraMetadata) ?? {};
  const out: Record<string, unknown> = {
    ...baseMetadata,
    ...extraMetadata,
    entryEndpoint: args.entryEndpoint,
    direction: 'request',
    stage: 'inbound'
  };

  const mergedClientHeaders = {
    ...(cloneStringHeaders(baseMetadata.clientHeaders) ?? {}),
    ...(cloneStringHeaders(extraMetadata.clientHeaders) ?? {})
  };
  if (Object.keys(mergedClientHeaders).length > 0) {
    out.clientHeaders = mergedClientHeaders;
  }

  try {
    const baseRt = asRecord((baseMetadata as Record<string, unknown>).__rt) ?? {};
    const extraRt = asRecord((extraMetadata as Record<string, unknown>).__rt) ?? {};
    if (Object.keys(baseRt).length || Object.keys(extraRt).length) {
      (out as Record<string, unknown>).__rt = { ...baseRt, ...extraRt };
    }
  } catch (error) {
    args.onMergeRuntimeMetaError?.(error);
  }

  const runtimeMeta = asRecord((out as Record<string, unknown>).__rt);
  if (runtimeMeta?.serverToolFollowup === true) {
    const continuityHeaders = extractFollowupSessionHeaders(out.clientHeaders);
    if (continuityHeaders) {
      const sessionId = extractPreservedSessionToken(continuityHeaders, 'session');
      const conversationId = extractPreservedSessionToken(continuityHeaders, 'conversation');
      const daemonId = extractPreservedInjectToken(continuityHeaders, 'daemon');
      const tmuxSessionId = extractPreservedInjectToken(continuityHeaders, 'tmux');
      const workdir = extractPreservedInjectToken(continuityHeaders, 'workdir');

      if (sessionId && !readNonEmptyString(out.sessionId)) {
        out.sessionId = sessionId;
      }
      if (conversationId && !readNonEmptyString(out.conversationId)) {
        out.conversationId = conversationId;
      }
      if (daemonId) {
        if (!readNonEmptyString(out.clientDaemonId)) {
          out.clientDaemonId = daemonId;
        }
        if (!readNonEmptyString(out.sessionDaemonId)) {
          out.sessionDaemonId = daemonId;
        }
        if (!readNonEmptyString(out.sessionClientDaemonId)) {
          out.sessionClientDaemonId = daemonId;
        }
      }
      if (tmuxSessionId) {
        if (!readNonEmptyString(out.clientTmuxSessionId)) {
          out.clientTmuxSessionId = tmuxSessionId;
        }
        if (!readNonEmptyString(out.tmuxSessionId)) {
          out.tmuxSessionId = tmuxSessionId;
        }
      }
      if (workdir) {
        if (!readNonEmptyString(out.clientWorkdir)) {
          out.clientWorkdir = workdir;
        }
        if (!readNonEmptyString(out.workdir)) {
          out.workdir = workdir;
        }
        if (!readNonEmptyString(out.cwd)) {
          out.cwd = workdir;
        }
      }
    }
    delete out.clientRequestId;
  }

  return out;
}
