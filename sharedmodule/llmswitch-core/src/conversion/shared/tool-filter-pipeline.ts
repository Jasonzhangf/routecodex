import { FilterEngine } from '../../filters/index.js';
import type { FilterContext, ToolFilterHints } from '../../filters/index.js';
import { loadFieldMapConfig } from '../../filters/utils/fieldmap-loader.js';
import { createSnapshotWriter } from '../snapshot-utils.js';
import { normalizeChatResponseReasoningToolsWithNative as normalizeChatResponseReasoningTools } from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

interface RequestFilterOptions {
  entryEndpoint?: string;
  requestId?: string;
  model?: string;
  profile?: string;
  stream?: boolean;
  toolFilterHints?: ToolFilterHints;
  /**
   * Optional raw payload snapshot for local tool governance (e.g. view_image exposure).
   */
  rawPayload?: Record<string, unknown>;
}

interface ResponseFilterOptions {
  entryEndpoint?: string;
  requestId?: string;
  profile?: string;
}

const REQUEST_FILTER_STAGES: Array<FilterContext['stage']> = [
  'request_pre',
  'request_map',
  'request_post',
  'request_finalize'
];

const RESPONSE_FILTER_STAGES: Array<FilterContext['stage']> = [
  'response_pre',
  'response_map',
  'response_post',
  'response_finalize'
];

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logToolFilterNonBlockingError(
  stage: string,
  error: unknown,
  details: Record<string, unknown>
): void {
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[tool-filter-pipeline] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function assertStageCoverage(
  label: string,
  registeredStages: Set<FilterContext['stage']>,
  skeletonStages: Array<FilterContext['stage']>
): void {
  const allowed = new Set(skeletonStages);
  const uncovered: string[] = [];
  for (const stage of registeredStages) {
    if (!allowed.has(stage)) {
      uncovered.push(stage);
    }
  }
  if (uncovered.length) {
    throw new Error(
      `[tool-filter-pipeline] ${label}: registered filter stage(s) not covered by skeleton: ${uncovered.join(', ')}`
    );
  }
}

export async function runChatRequestToolFilters(chatRequest: any, options: RequestFilterOptions = {}): Promise<any> {
  const reqCtxBase: Omit<FilterContext,'stage'> = {
    requestId: options.requestId ?? `req_${Date.now()}`,
    model: typeof options.model === 'string' ? options.model : (chatRequest && typeof chatRequest === 'object' && typeof (chatRequest as any).model === 'string' ? String((chatRequest as any).model) : 'unknown'),
    endpoint: options.entryEndpoint || '/v1/chat/completions',
    profile: options.profile || 'openai-chat',
    stream: options.stream === true,
    toolFilterHints: options.toolFilterHints,
    debug: { emit: () => {} }
  };
  const snapshot = createSnapshotWriter({
    requestId: reqCtxBase.requestId,
    endpoint: reqCtxBase.endpoint,
    folderHint: 'openai-chat'
  });
  const recordStage = (stage: string, payload: unknown) => {
    if (!snapshot) return;
    snapshot(stage, payload);
  };
  const preFiltered = applyLocalToolGovernance(chatRequest, options.rawPayload);
  recordStage('req_process_tool_filters_input', preFiltered);

  const engine = new FilterEngine();
  const registeredStages = new Set<FilterContext['stage']>();
  const register = (filter: { stage: FilterContext['stage'] } & object) => {
    registeredStages.add(filter.stage);
    engine.registerFilter(filter as any);
  };
  const profile = (reqCtxBase.profile || '').toLowerCase();
  const endpoint = (reqCtxBase.endpoint || '').toLowerCase();
  const isAnthropic = profile === 'anthropic-messages' || endpoint.includes('/v1/messages');
  if (!isAnthropic) {
    try {
      const { RequestToolListFilter } = await import('../../filters/index.js');
      register(new RequestToolListFilter());
    } catch (error) {
      logToolFilterNonBlockingError('request.import.RequestToolListFilter', error, {
        requestId: reqCtxBase.requestId,
        endpoint: reqCtxBase.endpoint,
        profile: reqCtxBase.profile
      });
    }
  }
  const {
    RequestToolCallsStringifyFilter,
    RequestToolChoicePolicyFilter
  } = await import('../../filters/index.js');
  register(new RequestToolCallsStringifyFilter());
  if (!isAnthropic) {
    register(new RequestToolChoicePolicyFilter());
  }
  try {
    const cfg = await loadFieldMapConfig('openai-openai.fieldmap.json');
    if (cfg) engine.setFieldMap(cfg);
    engine.registerTransform('stringifyJson', (v: unknown) => (typeof v === 'string') ? v : (() => { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } })());
  } catch (error) {
    logToolFilterNonBlockingError('request.loadFieldMapConfig', error, {
      requestId: reqCtxBase.requestId,
      endpoint: reqCtxBase.endpoint,
      profile: reqCtxBase.profile
    });
  }
  try {
    const { RequestOpenAIToolsNormalizeFilter, ToolPostConstraintsFilter } = await import('../../filters/index.js');
    register(new RequestOpenAIToolsNormalizeFilter());
    register(new ToolPostConstraintsFilter('request_finalize'));
  } catch (error) {
    logToolFilterNonBlockingError('request.import.RequestOpenAIToolsNormalizeFilter', error, {
      requestId: reqCtxBase.requestId,
      endpoint: reqCtxBase.endpoint,
      profile: reqCtxBase.profile
    });
  }
  assertStageCoverage('request', registeredStages, REQUEST_FILTER_STAGES);
  let staged: any = preFiltered;
  for (const stage of REQUEST_FILTER_STAGES) {
    staged = await engine.run(stage, staged, reqCtxBase);
    recordStage(`req_process_tool_filters_${stage}`, staged);
  }
  recordStage('req_process_tool_filters_output', staged);
  return staged;
}

function applyLocalToolGovernance(chatRequest: any, _rawPayload?: Record<string, unknown>): any {
  if (!chatRequest || typeof chatRequest !== 'object') {
    return chatRequest;
  }
  return chatRequest;
}

export async function runChatResponseToolFilters(chatJson: any, options: ResponseFilterOptions = {}): Promise<any> {
  const resCtxBase: Omit<FilterContext,'stage'> = {
    requestId: options.requestId ?? `req_${Date.now()}`,
    model: undefined,
    endpoint: options.entryEndpoint || '/v1/chat/completions',
    profile: options.profile || 'openai-chat',
    debug: { emit: () => {} }
  };
  const snapshot = createSnapshotWriter({
    requestId: resCtxBase.requestId,
    endpoint: resCtxBase.endpoint,
    folderHint: 'openai-chat'
  });
  const recordStage = (stage: string, payload: unknown) => {
    if (!snapshot) return;
    snapshot(stage, payload);
  };
  recordStage('resp_process_tool_filters_input', chatJson);

  try {
    if (chatJson && typeof chatJson === 'object') {
      chatJson = normalizeChatResponseReasoningTools(
        chatJson as Record<string, unknown>,
        'reasoning_choice'
      );
    }
  } catch (error) {
    logToolFilterNonBlockingError('response.normalizeChatResponseReasoningTools', error, {
      requestId: resCtxBase.requestId,
      endpoint: resCtxBase.endpoint,
      profile: resCtxBase.profile
    });
  }

  const engine = new FilterEngine();
  const registeredStages = new Set<FilterContext['stage']>();
  const register = (filter: { stage: FilterContext['stage'] } & object) => {
    registeredStages.add(filter.stage);
    engine.registerFilter(filter as any);
  };
  const {
    ResponseToolTextCanonicalizeFilter,
    ResponseToolArgumentsStringifyFilter,
    ResponseFinishInvariantsFilter,
    ResponseToolArgumentsBlacklistFilter,
    ResponseToolArgumentsSchemaConvergeFilter
  } = await import('../../filters/index.js');
  register(new ResponseToolTextCanonicalizeFilter());
  try {
    register(new ResponseToolArgumentsSchemaConvergeFilter());
  } catch (error) {
    logToolFilterNonBlockingError('response.register.ResponseToolArgumentsSchemaConvergeFilter', error, {
      requestId: resCtxBase.requestId,
      endpoint: resCtxBase.endpoint,
      profile: resCtxBase.profile
    });
  }
  register(new ResponseToolArgumentsBlacklistFilter());
  register(new ResponseToolArgumentsStringifyFilter());
  register(new ResponseFinishInvariantsFilter());
  try {
    const cfg = await loadFieldMapConfig('openai-openai.fieldmap.json');
    if (cfg) engine.setFieldMap(cfg);
    engine.registerTransform('stringifyJson', (v: unknown) => (typeof v === 'string') ? v : (() => { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } })());
  } catch (error) {
    logToolFilterNonBlockingError('response.loadFieldMapConfig', error, {
      requestId: resCtxBase.requestId,
      endpoint: resCtxBase.endpoint,
      profile: resCtxBase.profile
    });
  }
  assertStageCoverage('response', registeredStages, RESPONSE_FILTER_STAGES);
  let staged: any = chatJson as any;
  for (const stage of RESPONSE_FILTER_STAGES) {
    staged = await engine.run(stage, staged, resCtxBase);
    recordStage(`resp_process_tool_filters_${stage}`, staged);
  }
  recordStage('resp_process_tool_filters_output', staged);
  return staged;
}
