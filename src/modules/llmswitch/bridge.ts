import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

type AnyRecord = Record<string, unknown>;

// 单一桥接模块：这是全项目中唯一允许直接 import llmswitch-core 的地方。
// 其它代码（pipeline/provider/server/virtual-router/snapshot）都只能通过这里暴露的统一接口访问 llmswitch-core。
// 默认且唯一引用 sharedmodule/llmswitch-core/dist，本地缺失视为配置错误，直接 fail。

async function importCoreDist(subpath: string): Promise<any> {
  const clean = subpath.replace(/\.js$/i, '');
  const filename = `${clean}.js`;
  // 仅允许 sharedmodule/llmswitch-core/dist
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(__filename), '../../..');
  const localDist = path.join(pkgRoot, 'sharedmodule', 'llmswitch-core', 'dist');
  const candidate = path.join(localDist, filename);
  try {
    const url = pathToFileURL(candidate).href;
    return await import(url);
  } catch {
    throw new Error(`[llmswitch-bridge] Unable to load core module "${clean}" from ${candidate}. 请先构建 sharedmodule/llmswitch-core。`);
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

async function invokeCoreBridge(method: CoreBridgeMethod, payload: AnyRecord, opts: BridgeProcessOptions): Promise<any> {
  const mod = await importCoreDist('bridge/routecodex-adapter');
  const fn = (mod as any)?.[method];
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

export async function buildResponsesRequestFromChat(chatRequest: AnyRecord): Promise<any> {
  const mod = await importCoreDist('conversion/responses/responses-openai-bridge');
  const builder = mod as any;
  if (typeof builder.buildResponsesRequestFromChat !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesRequestFromChat not available');
  }
  return builder.buildResponsesRequestFromChat(chatRequest);
}

export async function writeSnapshotViaHooks(
  channelOrOptions: string | AnyRecord,
  payload?: AnyRecord
): Promise<void> {
  // Snapshot hooks shim lives inside llmswitch-core conversion shared modules.
  const mod = await importCoreDist('conversion/shared/snapshot-hooks').catch(() => null);
  const hooks = mod as any;
  if (!hooks || typeof hooks.writeSnapshotViaHooks !== 'function') return;

  const options =
    payload && typeof channelOrOptions === 'string'
      ? { ...payload, channel: (payload as AnyRecord).channel ?? channelOrOptions }
      : channelOrOptions;

  if (!options || typeof options !== 'object') return;
  await hooks.writeSnapshotViaHooks(options);
}

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string }
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const mod = await importCoreDist('conversion/shared/responses-conversation-store');
  const fn = (mod as any)?.resumeResponsesConversation;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resumeResponsesConversation not available');
  }
  return await fn(responseId, submitPayload, options);
}

function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) return env;
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}
