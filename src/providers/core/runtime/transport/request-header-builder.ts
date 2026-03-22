import type { ProviderRuntimeMetadata } from '../provider-runtime-metadata.js';
import type { ProviderFamilyProfile } from '../../../profile/profile-contracts.js';
import { HeaderUtils } from './header-utils.js';
import { IflowSigner } from './iflow-signer.js';
import { ProviderPayloadUtils } from './provider-payload-utils.js';
import { SessionHeaderUtils } from './session-header-utils.js';

export interface RequestHeaderBuildContext {
  baseHeaders: Record<string, string>;
  serviceHeaders: Record<string, string>;
  overrideHeaders: Record<string, string>;
  runtimeHeaders: Record<string, string>;
  authHeaders: Record<string, string>;
  normalizedClientHeaders?: Record<string, string>;
  inboundMetadata?: Record<string, unknown>;
  inboundUserAgent?: string;
  inboundOriginator?: string;
  runtimeMetadata?: ProviderRuntimeMetadata;
  familyProfile?: ProviderFamilyProfile;
  defaultUserAgent: string;
  isGeminiFamily: boolean;
  isAntigravity: boolean;
  isIflow: boolean;
  codexUaMode: boolean;
}

export class RequestHeaderBuilder {
  private static pickRecordString(source: unknown, keys: string[]): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const record = source as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return undefined;
  }

  private static findHeaderFromSources(
    target: string,
    ...sources: Array<Record<string, string> | undefined>
  ): string | undefined {
    for (const source of sources) {
      if (!source) {
        continue;
      }
      const value = HeaderUtils.findHeaderValue(source, target);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private static resolveOpenCodeZenProjectId(context: RequestHeaderBuildContext): string | undefined {
    return (
      RequestHeaderBuilder.findHeaderFromSources(
        'x-opencode-project',
        context.normalizedClientHeaders,
        context.runtimeHeaders,
        context.overrideHeaders,
        context.serviceHeaders
      ) ??
      RequestHeaderBuilder.pickRecordString(context.inboundMetadata, ['projectId', 'project_id']) ??
      RequestHeaderBuilder.pickRecordString(context.runtimeMetadata?.metadata, ['projectId', 'project_id'])
    );
  }

  private static resolveOpenCodeZenSessionId(context: RequestHeaderBuildContext): string | undefined {
    return (
      RequestHeaderBuilder.findHeaderFromSources(
        'x-opencode-session',
        context.normalizedClientHeaders,
        context.runtimeHeaders,
        context.overrideHeaders,
        context.serviceHeaders
      ) ??
      RequestHeaderBuilder.findHeaderFromSources('session_id', context.normalizedClientHeaders) ??
      RequestHeaderBuilder.findHeaderFromSources('conversation_id', context.normalizedClientHeaders) ??
      RequestHeaderBuilder.pickRecordString(context.inboundMetadata, [
        'sessionId',
        'session_id',
        'conversationId',
        'conversation_id'
      ]) ??
      RequestHeaderBuilder.pickRecordString(context.runtimeMetadata?.metadata, [
        'sessionId',
        'session_id',
        'conversationId',
        'conversation_id'
      ])
    );
  }

  private static resolveOpenCodeZenRequestId(context: RequestHeaderBuildContext): string | undefined {
    return (
      RequestHeaderBuilder.findHeaderFromSources(
        'x-opencode-request',
        context.normalizedClientHeaders,
        context.runtimeHeaders,
        context.overrideHeaders,
        context.serviceHeaders
      ) ??
      RequestHeaderBuilder.pickRecordString(context.inboundMetadata, [
        'requestId',
        'request_id',
        'clientRequestId',
        'client_request_id',
        'userId',
        'user_id'
      ]) ??
      RequestHeaderBuilder.pickRecordString(context.runtimeMetadata?.metadata, [
        'requestId',
        'request_id',
        'clientRequestId',
        'client_request_id',
        'userId',
        'user_id'
      ]) ??
      (typeof context.runtimeMetadata?.requestId === 'string' ? context.runtimeMetadata.requestId.trim() : undefined)
    );
  }

  private static resolveOpenCodeZenClient(context: RequestHeaderBuildContext): string | undefined {
    return (
      RequestHeaderBuilder.findHeaderFromSources(
        'x-opencode-client',
        context.normalizedClientHeaders,
        context.runtimeHeaders,
        context.overrideHeaders,
        context.serviceHeaders
      ) ??
      RequestHeaderBuilder.pickRecordString(context.inboundMetadata, ['opencodeClient', 'opencode_client']) ??
      RequestHeaderBuilder.pickRecordString(context.runtimeMetadata?.metadata, ['opencodeClient', 'opencode_client'])
    );
  }

  private static applyOpenCodeZenRoutingHeaders(
    finalHeaders: Record<string, string>,
    context: RequestHeaderBuildContext
  ): void {
    const projectId = RequestHeaderBuilder.resolveOpenCodeZenProjectId(context);
    if (projectId) {
      HeaderUtils.assignHeader(finalHeaders, 'x-opencode-project', projectId);
    }

    const sessionId = RequestHeaderBuilder.resolveOpenCodeZenSessionId(context);
    if (sessionId) {
      HeaderUtils.assignHeader(finalHeaders, 'x-opencode-session', sessionId);
    }

    const requestId = RequestHeaderBuilder.resolveOpenCodeZenRequestId(context);
    if (requestId) {
      HeaderUtils.assignHeader(finalHeaders, 'x-opencode-request', requestId);
    }

    const client = RequestHeaderBuilder.resolveOpenCodeZenClient(context);
    if (client) {
      HeaderUtils.assignHeader(finalHeaders, 'x-opencode-client', client);
    }
  }

  private static isOpenCodeZenRuntime(runtimeMetadata?: ProviderRuntimeMetadata): boolean {
    const providerId =
      typeof runtimeMetadata?.providerId === 'string' ? runtimeMetadata.providerId.trim().toLowerCase() : '';
    if (providerId === 'opencode-zen' || providerId === 'opencode-zen-free' || providerId.startsWith('opencode-zen-')) {
      return true;
    }
    const providerKey =
      typeof runtimeMetadata?.providerKey === 'string' ? runtimeMetadata.providerKey.trim().toLowerCase() : '';
    return (
      providerKey === 'opencode-zen' ||
      providerKey === 'opencode-zen-free' ||
      providerKey.startsWith('opencode-zen-')
    );
  }

  static buildGeminiDefaultHeaders(
    baseHeaders: Record<string, string>,
    runtimeMetadata?: ProviderRuntimeMetadata
  ): void {
    HeaderUtils.assignHeader(baseHeaders, 'X-Goog-Api-Client', 'gl-node/22.17.0');

    const clientMetadata = ProviderPayloadUtils.buildClientMetadata(runtimeMetadata);
    if (clientMetadata) {
      HeaderUtils.assignHeader(baseHeaders, 'Client-Metadata', clientMetadata);
    }

    HeaderUtils.assignHeader(baseHeaders, 'Accept-Encoding', 'gzip, deflate, br');

    const isStreaming = runtimeMetadata?.streaming === true;
    HeaderUtils.assignHeader(baseHeaders, 'Accept', isStreaming ? 'text/event-stream' : 'application/json');
  }

  static async buildHeaders(context: RequestHeaderBuildContext): Promise<Record<string, string>> {
    const finalHeaders: Record<string, string> = {
      ...context.baseHeaders,
      ...context.serviceHeaders,
      ...context.overrideHeaders,
      ...context.runtimeHeaders,
      ...context.authHeaders
    };
    const isOpenCodeZen = RequestHeaderBuilder.isOpenCodeZenRuntime(context.runtimeMetadata);

    const clientAccept = context.normalizedClientHeaders
      ? HeaderUtils.findHeaderValue(context.normalizedClientHeaders, 'Accept')
      : undefined;
    if (clientAccept) {
      HeaderUtils.assignHeader(finalHeaders, 'Accept', clientAccept);
    } else if (!HeaderUtils.findHeaderValue(finalHeaders, 'Accept')) {
      HeaderUtils.assignHeader(finalHeaders, 'Accept', 'application/json');
    }

    const uaFromConfig = HeaderUtils.findHeaderValue(
      { ...context.overrideHeaders, ...context.runtimeHeaders },
      'User-Agent'
    );
    const uaFromService = HeaderUtils.findHeaderValue(context.serviceHeaders, 'User-Agent');
    const profileResolvedUa = await context.familyProfile?.resolveUserAgent?.({
      uaFromConfig,
      uaFromService,
      inboundUserAgent: context.inboundUserAgent,
      defaultUserAgent: context.defaultUserAgent,
      runtimeMetadata: context.runtimeMetadata
    });
    if (isOpenCodeZen) {
      const resolvedUa = profileResolvedUa ?? uaFromConfig ?? context.inboundUserAgent ?? uaFromService;
      if (resolvedUa) {
        HeaderUtils.assignHeader(finalHeaders, 'User-Agent', resolvedUa);
      } else {
        HeaderUtils.deleteHeader(finalHeaders, 'User-Agent');
      }
    } else {
      const resolvedUa = context.isIflow
        ? (profileResolvedUa ?? uaFromConfig ?? uaFromService ?? context.inboundUserAgent ?? context.defaultUserAgent)
        : (profileResolvedUa ?? uaFromConfig ?? context.inboundUserAgent ?? uaFromService ?? context.defaultUserAgent);
      HeaderUtils.assignHeader(finalHeaders, 'User-Agent', resolvedUa);
    }

    if (!context.isGeminiFamily && !isOpenCodeZen) {
      const originatorFromConfig = HeaderUtils.findHeaderValue(
        { ...context.overrideHeaders, ...context.runtimeHeaders },
        'originator'
      );
      const originatorFromService = HeaderUtils.findHeaderValue(context.serviceHeaders, 'originator');
      const resolvedOriginator = originatorFromConfig ?? context.inboundOriginator ?? originatorFromService;
      if (resolvedOriginator) {
        HeaderUtils.assignHeader(finalHeaders, 'originator', resolvedOriginator);
      }
    }

    if (!context.isAntigravity && !isOpenCodeZen && context.normalizedClientHeaders) {
      const conversationId = HeaderUtils.findHeaderValue(context.normalizedClientHeaders, 'conversation_id');
      if (conversationId) {
        HeaderUtils.assignHeader(finalHeaders, 'conversation_id', conversationId);
      }
      const sessionId = HeaderUtils.findHeaderValue(context.normalizedClientHeaders, 'session_id');
      if (sessionId) {
        HeaderUtils.assignHeader(finalHeaders, 'session_id', sessionId);
      }
    }

    if (!context.isAntigravity && !isOpenCodeZen && context.inboundMetadata && typeof context.inboundMetadata === 'object') {
      const meta = context.inboundMetadata as Record<string, unknown>;
      const metaSessionId =
        typeof meta.sessionId === 'string' && meta.sessionId.trim() ? meta.sessionId.trim() : '';
      const metaConversationId =
        typeof meta.conversationId === 'string' && meta.conversationId.trim() ? meta.conversationId.trim() : '';
      const resolvedSessionId = metaSessionId || metaConversationId;
      const resolvedConversationId = metaConversationId || metaSessionId;
      if (resolvedSessionId && !HeaderUtils.findHeaderValue(finalHeaders, 'session_id')) {
        HeaderUtils.assignHeader(finalHeaders, 'session_id', resolvedSessionId);
      }
      if (resolvedConversationId && !HeaderUtils.findHeaderValue(finalHeaders, 'conversation_id')) {
        HeaderUtils.assignHeader(finalHeaders, 'conversation_id', resolvedConversationId);
      }
    }

    if (!context.isAntigravity && !isOpenCodeZen && context.codexUaMode) {
      SessionHeaderUtils.ensureCodexSessionHeaders(finalHeaders, context.runtimeMetadata);
    }

    if (context.isAntigravity || isOpenCodeZen) {
      HeaderUtils.deleteHeader(finalHeaders, 'session_id');
      HeaderUtils.deleteHeader(finalHeaders, 'conversation_id');
      HeaderUtils.deleteHeader(finalHeaders, 'originator');
    }

    if (isOpenCodeZen) {
      RequestHeaderBuilder.applyOpenCodeZenRoutingHeaders(finalHeaders, context);
    }

    if (context.isIflow) {
      IflowSigner.enforceIflowCliHeaders(finalHeaders);
    }

    return finalHeaders;
  }
}
