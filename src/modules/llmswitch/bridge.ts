import path from 'path';
import { fileURLToPath } from 'url';
import { importCoreModule } from './core-loader.js';

type AnyRecord = Record<string, unknown>;
type WithBaseDir = BridgeProcessOptions & { baseDir: string };
type BridgeHandler = (payload: AnyRecord, options: WithBaseDir) => Promise<AnyRecord>;
type RouteCodexBridgeModule = Partial<Record<CoreBridgeMethod, BridgeHandler>>;

// 单一桥接模块：这是全项目中唯一允许直接 import llmswitch-core 的地方。
// 其它代码（pipeline/provider/server/virtual-router/snapshot）都只能通过这里暴露的统一接口访问 llmswitch-core。
// 默认引用 @jsonstudio/llms（来自 npm 发布版本）。仓库开发场景可通过 scripts/link-llmswitch.mjs 将该依赖 link 到本地 sharedmodule。

async function importCoreDist<TModule extends object = AnyRecord>(subpath: string): Promise<TModule> {
  try {
    return await importCoreModule<TModule>(subpath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[llmswitch-bridge] Unable to load core module "${subpath}". 请确认 @jsonstudio/llms 依赖已安装（npm install）。${detail ? ` (${detail})` : ''}`
    );
  }
}

export type BridgeProcessOptions = {
  processMode: 'chat' | 'passthrough';
  providerProtocol?: string;
  providerType?: string;
  entryEndpoint?: string;
};

type CoreBridgeMethod =
  | 'processIncoming'
  | 'processOutgoing'
  | 'processInboundRequest'
  | 'processInboundResponse'
  | 'processOutboundRequest'
  | 'processOutboundResponse';

async function invokeCoreBridge(
  method: CoreBridgeMethod,
  payload: AnyRecord,
  opts: BridgeProcessOptions
): Promise<AnyRecord> {
  const mod = await importCoreDist<RouteCodexBridgeModule>('bridge/routecodex-adapter');
  const fn = mod[method];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${method} not available on core adapter`);
  }
  const baseDir = resolveBaseDir();
  const { processMode, providerProtocol, entryEndpoint, providerType } = opts;
  return await fn(payload, {
    baseDir,
    processMode,
    providerProtocol,
    providerType,
    entryEndpoint
  });
}

export async function bridgeProcessIncoming(request: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processInboundRequest', request, opts);
}

export async function bridgeProcessOutgoing(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processOutboundResponse', response, opts);
}

export async function bridgeProcessInboundResponse(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processInboundResponse', response, opts);
}

export async function bridgeProcessOutboundRequest(request: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processOutboundRequest', request, opts);
}

export async function bridgeProcessOutboundResponse(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processOutboundResponse', response, opts);
}

type ResponsesBridgeModule = {
  buildResponsesRequestFromChat?: (request: AnyRecord) => Promise<AnyRecord>;
  ensureResponsesApplyPatchArguments?: (input?: unknown[]) => void;
};

export async function buildResponsesRequestFromChat(chatRequest: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist<ResponsesBridgeModule>('conversion/responses/responses-openai-bridge');
  const builder = mod.buildResponsesRequestFromChat;
  if (typeof builder !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesRequestFromChat not available');
  }
  return builder(chatRequest);
}

export async function ensureResponsesApplyPatchArguments(input?: unknown[]): Promise<void> {
  const mod = await importCoreDist<ResponsesBridgeModule>('conversion/responses/responses-openai-bridge');
  const fn = mod.ensureResponsesApplyPatchArguments;
  if (typeof fn === 'function') {
    fn(input as unknown[]);
  }
}

type SnapshotHooksModule = {
  writeSnapshotViaHooks?: (options: AnyRecord) => Promise<void> | void;
};

export async function writeSnapshotViaHooks(channelOrOptions: string | AnyRecord, payload?: AnyRecord): Promise<void> {
  let hooksModule: SnapshotHooksModule | null = null;
  try {
    hooksModule = await importCoreDist<SnapshotHooksModule>('conversion/shared/snapshot-hooks');
  } catch {
    hooksModule = null;
  }
  const writer = hooksModule?.writeSnapshotViaHooks;
  if (typeof writer !== 'function') {
    return;
  }

  let options: AnyRecord | undefined;
  if (payload && typeof channelOrOptions === 'string') {
    const channelValue =
      typeof payload.channel === 'string' && payload.channel ? payload.channel : channelOrOptions;
    options = {
      ...payload,
      channel: channelValue
    };
  } else if (channelOrOptions && typeof channelOrOptions === 'object') {
    options = channelOrOptions;
  }

  if (!options) {
    return;
  }

  await writer(options);
}

type ResponsesConversationModule = {
  resumeResponsesConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: { requestId?: string }
  ) => Promise<{ payload: AnyRecord; meta: AnyRecord }>;
  rebindResponsesConversationRequestId?: (oldId: string, newId: string) => void;
};

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string }
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const mod = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
  const fn = mod.resumeResponsesConversation;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resumeResponsesConversation not available');
  }
  return await fn(responseId, submitPayload, options);
}

export async function rebindResponsesConversationRequestId(oldId?: string, newId?: string): Promise<void> {
  if (!oldId || !newId || oldId === newId) {
    return;
  }
  const mod = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
  const fn = mod.rebindResponsesConversationRequestId;
  if (typeof fn === 'function') {
    fn(oldId, newId);
  }
}

function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) {
    return env;
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}
