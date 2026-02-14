/**
 * Response Converter Bridge
 *
 * Provider response conversion with shadow engine support.
 */

import {
  importCoreDist,
  resolveImplForSubpath,
  type AnyRecord,
  type LlmsImpl
} from './module-loader.js';
import {
  isLlmsEngineShadowEnabledForSubpath,
  recordLlmsEngineShadowDiff,
  resolveLlmsEngineShadowConfig,
  shouldRunLlmsEngineShadowForSubpath
} from '../../../utils/llms-engine-shadow.js';

type ProviderResponseConversionModule = {
  convertProviderResponse?: (options: AnyRecord) => Promise<AnyRecord> | AnyRecord;
};

const cachedConvertProviderResponseByImpl: Record<LlmsImpl, ((options: AnyRecord) => Promise<AnyRecord>) | null> = {
  ts: null,
  engine: null
};

const llmsEngineShadowConfig = resolveLlmsEngineShadowConfig();

/**
 * Host/HTTP 侧统一使用的 provider 响应转换入口。
 * 封装 llmswitch-core 的 convertProviderResponse，避免在 Host 内部直接 import core 模块。
 */
export async function convertProviderResponse(options: AnyRecord): Promise<AnyRecord> {
  const subpath = 'conversion/hub/response/provider-response';

  const ensureFn = async (impl: LlmsImpl) => {
    if (!cachedConvertProviderResponseByImpl[impl]) {
      const mod = await importCoreDist<ProviderResponseConversionModule>(subpath, impl);
      const fn = mod.convertProviderResponse;
      if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] convertProviderResponse not available');
      }
      cachedConvertProviderResponseByImpl[impl] = async (opts: AnyRecord) => {
        const result = fn(opts);
        return result instanceof Promise ? await result : result;
      };
    }
    return cachedConvertProviderResponseByImpl[impl]!;
  };

  const shadowEnabled = isLlmsEngineShadowEnabledForSubpath(llmsEngineShadowConfig, 'conversion/hub/response');
  if (shadowEnabled) {
    // Fail fast: if shadow is enabled for this module, engine core must be available.
    await ensureFn('engine');
  }
  const wantsShadow = shadowEnabled && shouldRunLlmsEngineShadowForSubpath(llmsEngineShadowConfig, 'conversion/hub/response');
  if (wantsShadow) {
    const baseline = await (await ensureFn('ts'))(options);
    const requestId =
      typeof (options as AnyRecord).requestId === 'string'
        ? String((options as AnyRecord).requestId)
        : (typeof (options as AnyRecord).id === 'string' ? String((options as AnyRecord).id) : `shadow_${Date.now()}`);
    void (async () => {
      try {
        const candidate = await (await ensureFn('engine'))(options);
        await recordLlmsEngineShadowDiff({
          group: 'provider-response',
          requestId,
          subpath: 'conversion/hub/response',
          baselineImpl: 'ts',
          candidateImpl: 'engine',
          baselineOut: baseline,
          candidateOut: candidate,
          excludedComparePaths: []
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[llms-engine-shadow] provider response shadow failed:', error);
      }
    })();
    return baseline;
  }

  const impl = resolveImplForSubpath(subpath);
  return await (await ensureFn(impl))(options);
}
