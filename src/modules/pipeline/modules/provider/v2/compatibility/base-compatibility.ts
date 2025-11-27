import type { UnknownObject } from '../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../types/module.types.js';
import type { CompatibilityContext } from './compatibility-interface.js';
import { UniversalShapeFilter } from './filters/universal-shape-filter.js';
import { ResponseBlacklistSanitizer } from './filters/response-blacklist-sanitizer.js';
import * as path from 'path';

export interface BaseCompatibilityOptions {
  providerType: string;
  shapeFilterConfigPath: string; // JSON config for request/response filtering
  // Optional mapping functions (provider-specific field mappings)
  mapper?: {
    mapIncoming?: (request: UnknownObject) => Promise<UnknownObject> | UnknownObject;
    mapOutgoing?: (response: UnknownObject) => Promise<UnknownObject> | UnknownObject;
  };
  // Optional validators (entry checks)
  validator?: {
    request?: (request: UnknownObject) => Promise<UnknownObject> | UnknownObject;
    response?: (response: UnknownObject) => Promise<UnknownObject> | UnknownObject;
  };
}

export class BaseCompatibility {
  protected readonly deps: ModuleDependencies;
  protected readonly opts: BaseCompatibilityOptions;
  protected filter: UniversalShapeFilter;
  protected respBlacklist: ResponseBlacklistSanitizer;

  constructor(dependencies: ModuleDependencies, options: BaseCompatibilityOptions) {
    this.deps = dependencies;
    this.opts = options;
    this.filter = new UniversalShapeFilter({ configPath: options.shapeFilterConfigPath });
    const respCfgPath = (() => {
      try {
        const dir = path.dirname(options.shapeFilterConfigPath || '');
        return path.join(dir, 'response-blacklist.json');
      } catch { return ''; }
    })();
    this.respBlacklist = new ResponseBlacklistSanitizer({ configPath: respCfgPath });
  }

  async initialize(): Promise<void> {
    await this.filter.initialize();
    await this.respBlacklist.initialize();
  }

  async processIncoming(input: UnknownObject, ctx: CompatibilityContext): Promise<UnknownObject> {
    let req = input;
    // compat-pre snapshot (non-blocking)
    try {
      const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
      await writeCompatSnapshot({ phase: 'compat-pre', requestId: ctx.requestId, data: req, entryEndpoint: (ctx as any)?.entryEndpoint as string | undefined });
    } catch { /* ignore */ }

    // Standard sequence: filter → mapping → filter
    try { req = await this.filter.applyRequestFilter(req); } catch { /* ignore */ }
    if (this.opts.validator?.request) {
      try { req = await this.opts.validator.request(req); } catch { /* ignore */ }
    }
    if (this.opts.mapper?.mapIncoming) {
      try { req = await this.opts.mapper.mapIncoming(req); } catch { /* ignore */ }
    }
    try { req = await this.filter.applyRequestFilter(req); } catch { /* ignore */ }
    // compat-post snapshot (non-blocking)
    try {
      const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
      await writeCompatSnapshot({ phase: 'compat-post', requestId: ctx.requestId, data: req, entryEndpoint: (ctx as any)?.entryEndpoint as string | undefined });
    } catch { /* ignore */ }
    return req;
  }

  async processOutgoing(input: UnknownObject, ctx: CompatibilityContext): Promise<UnknownObject> {
    let res = input;
    // Provider可能返回 { data, status, headers } 外壳，先解包
    try {
      const anyRes: any = res as any;
      if (anyRes && typeof anyRes === 'object' && 'data' in anyRes && ('status' in anyRes || 'headers' in anyRes)) {
        res = anyRes.data ?? res;
      }
    } catch { /* ignore */ }
    // compat-pre snapshot for response (non-blocking)
    try {
      const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
      await writeCompatSnapshot({ phase: 'compat-pre', requestId: ctx.requestId, data: res, entryEndpoint: (ctx as any)?.entryEndpoint as string | undefined });
    } catch { /* ignore */ }

    // Standard sequence: validate(entry) → filter → mapping → filter
    // Minimal blacklist only on non-stream path (exclude /v1/responses)
    try {
      const entry = String((ctx as any)?.entryEndpoint || '').toLowerCase();
      if (entry !== '/v1/responses') {
        res = await this.respBlacklist.apply(res);
      }
    } catch { /* ignore blacklist errors */ }

    if (this.opts.validator?.response) {
      try { res = await this.opts.validator.response(res); } catch { /* ignore */ }
    }
    try { res = await this.filter.applyResponseFilter(res, ctx); } catch { /* ignore */ }
    if (this.opts.mapper?.mapOutgoing) {
      try { res = await this.opts.mapper.mapOutgoing(res); } catch { /* ignore */ }
    }
    try { res = await this.filter.applyResponseFilter(res, ctx); } catch { /* ignore */ }
    // compat-post snapshot for response (non-blocking)
    try {
      const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
      await writeCompatSnapshot({ phase: 'compat-post', requestId: ctx.requestId, data: res, entryEndpoint: (ctx as any)?.entryEndpoint as string | undefined });
    } catch { /* ignore */ }
    return res;
  }
}
