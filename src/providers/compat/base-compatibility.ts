import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from './compatibility-interface.js';
import { UniversalShapeFilter } from './filters/universal-shape-filter.js';
import { ResponseBlacklistSanitizer } from './filters/response-blacklist-sanitizer.js';
import * as path from 'path';
import type { JsonValue } from '../../types/common-types.js';

type ResponseEnvelope = UnknownObject & {
  data?: UnknownObject | JsonValue;
  status?: number;
  headers?: UnknownObject;
};

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponseEnvelope(value: UnknownObject): value is ResponseEnvelope {
  return ('data' in value) && ('status' in value || 'headers' in value);
}

function unwrapResponseEnvelope(value: UnknownObject): UnknownObject {
  if (isResponseEnvelope(value) && isRecord(value.data)) {
    return value.data;
  }
  return value;
}

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
      await writeCompatSnapshot({
        phase: 'compat-pre',
        requestId: ctx.requestId,
        data: req,
        entryEndpoint: ctx.entryEndpoint
      });
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
      await writeCompatSnapshot({
        phase: 'compat-post',
        requestId: ctx.requestId,
        data: req,
        entryEndpoint: ctx.entryEndpoint
      });
    } catch { /* ignore */ }
    return req;
  }

  async processOutgoing(input: UnknownObject, ctx: CompatibilityContext): Promise<UnknownObject> {
    let res = unwrapResponseEnvelope(input);
    // compat-pre snapshot for response (non-blocking)
    try {
      const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
      await writeCompatSnapshot({
        phase: 'compat-pre',
        requestId: ctx.requestId,
        data: res,
        entryEndpoint: ctx.entryEndpoint
      });
    } catch { /* ignore */ }

    // Standard sequence: validate(entry) → filter → mapping → filter
    // Minimal blacklist only on non-stream path (exclude /v1/responses)
    try {
      const entry = String(ctx.entryEndpoint ?? '').toLowerCase();
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
      await writeCompatSnapshot({
        phase: 'compat-post',
        requestId: ctx.requestId,
        data: res,
        entryEndpoint: ctx.entryEndpoint
      });
    } catch { /* ignore */ }
    return res;
  }
}
