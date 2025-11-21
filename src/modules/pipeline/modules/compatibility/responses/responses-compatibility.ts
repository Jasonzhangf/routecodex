import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { ModuleDependencies } from '../../../../../types/module.types.js';
import type { UnknownObject } from '../../../../../types/common-types.js';

export class ResponsesCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'responses-compatibility';
  readonly config: unknown = {};
  private deps: ModuleDependencies;
  private inited = false;

  constructor(deps: ModuleDependencies) {
    this.deps = deps;
    this.id = `responses-compatibility-${Date.now()}`;
  }

  async initialize(): Promise<void> {
    this.inited = true;
    this.deps.logger?.logModule('responses-compatibility', 'initialized', {});
  }

  async processIncoming(request: UnknownObject, _ctx: CompatibilityContext): Promise<UnknownObject> {
    if (!this.inited) throw new Error('ResponsesCompatibility not initialized');
    try {
      const dto = request as any;
      const data = (dto && typeof dto === 'object') ? (dto.data || dto) : dto;
      const meta = (dto && typeof dto === 'object') ? (dto.metadata || (dto.data ? (dto.data as any).metadata : {})) : {};
      const entry = String((meta?.entryEndpoint || '') as string).toLowerCase();
      const isResponses = entry === '/v1/responses';
      if (!isResponses) return request;

      // 最小兼容（请求侧）：
      // 1) 统一调整 response_format.text.verbosity → 'high'
      try {
        const rf = (data as UnknownObject).response_format as UnknownObject | undefined;
        const rtext = rf && typeof rf === 'object' ? (rf as any).text as UnknownObject | undefined : undefined;
        const v = rtext && typeof rtext === 'object' ? (rtext as any).verbosity : undefined;
        if (typeof v !== 'string' || v.trim().toLowerCase() !== 'high') {
          if (rtext && typeof rtext === 'object') {
            (rtext as any).verbosity = 'high';
            this.deps.logger?.logModule('responses-compatibility', 'normalized-verbosity', { from: v, to: 'high' });
          }
        }
      } catch { /* ignore normalization errors */ }

      // 2) 删除非标准/冲突的 max token 变体（SSE/非SSE一致执行）：
      try {
        const drop = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            const lower = k.toLowerCase();
            if (lower === 'maxtoken' || lower === 'maxtokens' || k === 'maxToken' || k === 'maxTokens' || k === 'max_tokens') {
              delete (obj as any)[k];
            }
          }
        };
        drop(data);
      } catch { /* ignore safe-prune errors */ }

      return request;
    } catch (e) {
      this.deps.logger?.logModule('responses-compatibility', 'process-incoming-error', { error: (e as Error)?.message });
      throw e;
    }
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> { return response; }
  async cleanup(): Promise<void> { this.inited = false; }
  getStatus(): any { return { id: this.id, initialized: this.inited }; }
}
