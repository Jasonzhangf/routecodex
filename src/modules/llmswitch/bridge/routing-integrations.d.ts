/**
 * Routing Integrations Bridge
 *
 * Virtual router bootstrap + hub pipeline constructor + host base dir resolver.
 */
import type { AnyRecord, LlmsImpl } from './module-loader.js';
export declare function bootstrapVirtualRouterConfig(input: AnyRecord): Promise<AnyRecord>;
type HubPipelineCtorAny = new (config: AnyRecord) => AnyRecord;
export declare function getHubPipelineCtor(): Promise<HubPipelineCtorAny>;
export declare function getHubPipelineCtorForImpl(impl: LlmsImpl): Promise<HubPipelineCtorAny>;
export declare function resolveBaseDir(): string;
export {};
