import type { AnyRecord } from './module-loader.js';
import { convertProviderResponse as convertProviderResponseHost } from './provider-response-converter-host.js';

/**
 * Host/HTTP 侧统一使用的 provider 响应转换入口。
 * 封装 llmswitch-core 的 convertProviderResponse，避免在 Host 内部直接 import core 模块。
 */
export async function convertProviderResponse(options: AnyRecord): Promise<AnyRecord> {
  return await convertProviderResponseHost(options as Parameters<typeof convertProviderResponseHost>[0]) as AnyRecord;
}
