import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolBackendPlan,
  ServerToolBackendResult,
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan,
  ServerToolHandlerResult,
} from './types.js';
import { executeVisionBackendPlan } from './handlers/vision.js';
import { executeWebSearchBackendPlan } from './handlers/web-search.js';
import {
  planServertoolBackendExecutionWithNative,
  planServertoolHandlerContractWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export interface ServertoolExecutedRecord {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode: string;
    stripAfterExecute: boolean;
  };
  execution?: {
    flowId: string;
    followup?: unknown;
    context?: unknown;
  };
}

export interface ServertoolExecutionLoopState {
  executedToolCalls: ServertoolExecutedRecord[];
  executedIds: Set<string>;
  executedFlowIds: string[];
  lastExecution?: {
    flowId: string;
    followup?: unknown;
    context?: unknown;
  };
}

type BackendIoExecutorMap = {
  [K in ServerToolBackendPlan['kind']]: (args: {
    plan: Extract<ServerToolBackendPlan, { kind: K }>;
    options: ServerSideToolEngineOptions;
  }) => Promise<ServerToolBackendResult | undefined>;
};

function planHandlerMaterializationAction(
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): 'handler_plan' | 'handler_result' {
  const maybePlan = planned as {
    flowId?: unknown;
    backend?: unknown;
    finalize?: unknown;
    chatResponse?: unknown;
    execution?: unknown;
  };
  const execution = maybePlan.execution as { flowId?: unknown } | undefined;
  const plan = planServertoolHandlerContractWithNative({
    hasFinalizeFunction: typeof maybePlan.finalize === 'function',
    hasChatResponseObject: Boolean(maybePlan.chatResponse && typeof maybePlan.chatResponse === 'object' && !Array.isArray(maybePlan.chatResponse)),
    hasExecutionObject: Boolean(maybePlan.execution && typeof maybePlan.execution === 'object' && !Array.isArray(maybePlan.execution)),
    hasExecutionFlowId: typeof execution?.flowId === 'string',
    hasPlanMarkers: typeof maybePlan.flowId === 'string' || maybePlan.backend !== undefined || maybePlan.finalize !== undefined
  });
  if (plan.action === 'handler_plan' || plan.action === 'handler_result') {
    return plan.action;
  }
  if (plan.action === 'invalid_plan_missing_finalize') {
    throw new ProviderProtocolError('[servertool] invalid handler plan contract: missing finalize', {
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        requestId: options.requestId
      }
    });
  }
  throw new ProviderProtocolError('[servertool] invalid handler plan/result contract', {
    code: 'SERVERTOOL_HANDLER_FAILED',
    category: 'INTERNAL_ERROR',
    details: {
      requestId: options.requestId
    }
  });
}

const backendIoExecutors: BackendIoExecutorMap = {
  vision_analysis: async ({ plan, options }) => {
    if (!options.reenterPipeline) {
      throw new ProviderProtocolError('[servertool] vision_analysis backend requires reenterPipeline', {
        code: 'SERVERTOOL_HANDLER_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          requestId: options.requestId,
          backendKind: plan.kind
        }
      });
    }
    return await executeVisionBackendPlan({ plan, options });
  },
  web_search: async ({ plan, options }) => await executeWebSearchBackendPlan({ plan, options })
};

export const materializeServertoolPlannedResult = async (
  planned: ServerToolHandlerPlan | ServerToolHandlerResult,
  options: ServerSideToolEngineOptions
): Promise<ServerToolHandlerResult | null> => {
  if (planHandlerMaterializationAction(planned, options) === 'handler_plan') {
    const plan = planned as ServerToolHandlerPlan;
    const backendResult = plan.backend ? await executeServertoolBackendPlan(plan.backend, options) : undefined;
    return await plan.finalize({ ...(backendResult ? { backendResult } : {}) });
  }
  return planned as ServerToolHandlerResult;
};

export const runServertoolHandler = async (
  handler: (ctx: ServerToolHandlerContext) => Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null>,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | ServerToolHandlerResult | null> => {
  try {
    return await handler(ctx);
  } catch (error) {
    const toolName =
      ctx && ctx.toolCall && typeof ctx.toolCall.name === 'string' && ctx.toolCall.name.trim()
        ? ctx.toolCall.name.trim()
        : 'auto';
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const wrapped = new ProviderProtocolError(`[servertool] handler failed: ${toolName}: ${message}`, {
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        toolName,
        requestId: ctx.requestId,
        entryEndpoint: ctx.entryEndpoint,
        providerProtocol: ctx.providerProtocol,
        error: message
      }
    }) as ProviderProtocolError & { status?: number; cause?: unknown };
    wrapped.status = 500;
    wrapped.cause = error;
    throw wrapped;
  }
};

export const executeServertoolBackendPlan = async (
  plan: ServerToolBackendPlan,
  options: ServerSideToolEngineOptions
): Promise<ServerToolBackendResult | undefined> => {
  if (!plan) return undefined;
  const nativePlan = planServertoolBackendExecutionWithNative({ kind: (plan as { kind?: string }).kind });
  if (nativePlan.action === 'vision_analysis' || nativePlan.action === 'web_search') {
    const executor = backendIoExecutors[nativePlan.action as keyof BackendIoExecutorMap];
    return await executor({
      plan: plan as never,
      options
    });
  }
  throw new ProviderProtocolError(`[servertool] unsupported backend plan kind: ${nativePlan.backendKind}`, {
    code: 'SERVERTOOL_HANDLER_FAILED',
    category: 'INTERNAL_ERROR',
    details: {
      requestId: options.requestId,
      backendKind: nativePlan.backendKind
    }
  });
};
