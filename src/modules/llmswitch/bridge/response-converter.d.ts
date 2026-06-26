/**
 * Response Converter Bridge
 *
 * Provider response conversion with shadow engine support.
 */
import { type AnyRecord } from './module-loader.js';
/**
 * Host/HTTP 侧统一使用的 provider 响应转换入口。
 * 封装 llmswitch-core 的 convertProviderResponse，避免在 Host 内部直接 import core 模块。
 */
export declare function convertProviderResponse(options: AnyRecord): Promise<AnyRecord>;
