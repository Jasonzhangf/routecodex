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
    const resolvedUa = profileResolvedUa ?? (context.isIflow
      ? (uaFromConfig ?? uaFromService ?? context.inboundUserAgent ?? context.defaultUserAgent)
      : (uaFromConfig ?? context.inboundUserAgent ?? uaFromService ?? context.defaultUserAgent));
    HeaderUtils.assignHeader(finalHeaders, 'User-Agent', resolvedUa);

    if (!context.isGeminiFamily) {
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

    if (!context.isAntigravity && context.normalizedClientHeaders) {
      const conversationId = HeaderUtils.findHeaderValue(context.normalizedClientHeaders, 'conversation_id');
      if (conversationId) {
        HeaderUtils.assignHeader(finalHeaders, 'conversation_id', conversationId);
      }
      const sessionId = HeaderUtils.findHeaderValue(context.normalizedClientHeaders, 'session_id');
      if (sessionId) {
        HeaderUtils.assignHeader(finalHeaders, 'session_id', sessionId);
      }
    }

    if (!context.isAntigravity && context.inboundMetadata && typeof context.inboundMetadata === 'object') {
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

    if (!context.isAntigravity && context.codexUaMode) {
      SessionHeaderUtils.ensureCodexSessionHeaders(finalHeaders, context.runtimeMetadata);
    }

    if (context.isAntigravity) {
      HeaderUtils.deleteHeader(finalHeaders, 'session_id');
      HeaderUtils.deleteHeader(finalHeaders, 'conversation_id');
    }

    if (context.isIflow) {
      IflowSigner.enforceIflowCliHeaders(finalHeaders);
    }

    return finalHeaders;
  }
}
