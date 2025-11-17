import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

type AnyRecord = Record<string, unknown>;

// 单一桥接模块：这是全项目中唯一允许直接 import rcc-llmswitch-core 的地方。
// 其它代码（pipeline/provider/server/virtual-router/snapshot）都只能通过这里暴露的统一接口访问 llmswitch-core。

async function importCoreDist(subpath: string): Promise<any> {
  const clean = subpath.replace(/\.js$/i, '');
  const filename = `${clean}.js`;
  // 优先 vendor/rcc-llmswitch-core/dist
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(__filename), '../../..');
  const vendor = path.join(pkgRoot, 'vendor', 'rcc-llmswitch-core', 'dist');
  const candidate = path.join(vendor, filename);
  try {
    const url = pathToFileURL(candidate).href;
    return await import(url);
  } catch {
    // 回退到已安装的 rcc-llmswitch-core 包（用于全局安装场景）
    return await import('rcc-llmswitch-core/' + clean.replace(/\\/g, '/'));
  }
}

export type BridgeProcessOptions = {
  processMode: 'chat' | 'passthrough';
  providerProtocol?: string;
  profilesPath?: string;
  // 由宿主提供的“二轮请求”回调，签名不做强约束以兼容现有实现
  invokeSecondRound?: (...args: any[]) => Promise<any>;
};

export async function bridgeProcessIncoming(request: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  const mod = await importCoreDist('v2/bridge/routecodex-adapter');
  const fn = (mod as any)?.processIncoming;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] processIncoming not available on core adapter');
  }
  const baseDir = resolveBaseDir();
  const { processMode, providerProtocol, profilesPath } = opts;
  return await fn(request, {
    baseDir,
    profilesPath: profilesPath || 'config/conversion/llmswitch-profiles.json',
    processMode,
    providerProtocol
  });
}

export async function bridgeProcessOutgoing(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  const mod = await importCoreDist('v2/bridge/routecodex-adapter');
  const fn = (mod as any)?.processOutgoing;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] processOutgoing not available on core adapter');
  }
  const baseDir = resolveBaseDir();
  const { processMode, profilesPath, invokeSecondRound, providerProtocol } = opts;
  return await fn(response, {
    baseDir,
    profilesPath: profilesPath || 'config/conversion/llmswitch-profiles.json',
    processMode,
    providerProtocol,
    invokeSecondRound
  });
}

export async function createResponsesSSEStreamFromOpenAI(chatJson: AnyRecord, ctx: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist('v2/conversion/streaming/openai-to-responses-stream');
  const fn = (mod as any)?.createResponsesSSEStreamFromOpenAI;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] createResponsesSSEStreamFromOpenAI not available');
  }
  return await fn(chatJson, ctx);
}

export async function buildResponsesRequestFromChat(chatRequest: AnyRecord): Promise<any> {
  const mod = await importCoreDist('v2/conversion/responses/responses-openai-bridge');
  const builder = mod as any;
  if (typeof builder.buildResponsesRequestFromChat !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesRequestFromChat not available');
  }
  return builder.buildResponsesRequestFromChat(chatRequest);
}

export async function writeSnapshotViaHooks(subpath: string, payload: AnyRecord): Promise<void> {
  // hooks-integration 由 core 提供；桥接层只负责调用。
  const mod = await import('rcc-llmswitch-core/v2/hooks/hooks-integration').catch(() => null);
  const hooks = mod as any;
  if (!hooks || typeof hooks.writeSnapshotViaHooks !== 'function') return;
  await hooks.writeSnapshotViaHooks(subpath, payload);
}

export async function estimateTokens(text: string, model?: string): Promise<number> {
  const mod = await import('rcc-llmswitch-core/v2/utils/token-counter').catch(() => null);
  const tc = mod as any;
  if (!tc || typeof tc.estimateTextTokens !== 'function') return 0;
  return await tc.estimateTextTokens(text, model);
}

export async function calculateRequestTokensStrict(request: AnyRecord, model?: string): Promise<{ inputTokens: number; toolTokens?: number }> {
  const mod = await importCoreDist('v2/utils/token-counter');
  const TokenCounter = (mod as any)?.TokenCounter;
  if (!TokenCounter || typeof TokenCounter.calculateRequestTokensStrict !== 'function') {
    throw new Error('[llmswitch-bridge] TokenCounter.calculateRequestTokensStrict not available');
  }
  return await TokenCounter.calculateRequestTokensStrict(
    request,
    typeof model === 'string' && model.trim() ? model.trim() : 'gpt-3.5-turbo'
  );
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
