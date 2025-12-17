import { createRequire } from 'module';

// Local colored logger wrapper that stays aligned with the bundled pipeline utils
// implementation in dist. We resolve ColoredLogger directly from the compiled
// modules/ tree using a module-local require,避免依赖全局 require 造成路径错误。

const localRequire = createRequire(import.meta.url);

export function createServerColoredLogger(): any {
  const isDev = String(process.env.BUILD_MODE || process.env.RCC_BUILD_MODE || 'release').toLowerCase() === 'dev';

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = localRequire('../../../modules/pipeline/utils/colored-logger.js');
    const ColoredLogger = (mod as any).ColoredLogger || (mod as any).default || null;

    if (ColoredLogger) {
      return new ColoredLogger({ isDev });
    }

    // If the module loaded but ColoredLogger is missing, emit a warning and fall back to a no-op logger.
    console.warn('[routecodex] ColoredLogger export not found in dist index; colored logs (provider/virtual-router) are disabled.');
  } catch (err) {
    // If require fails entirely, warn once and fall back to a no-op logger.
    console.warn('[routecodex] Failed to load ColoredLogger from dist index; colored logs (provider/virtual-router) are disabled.', err);
  }

  // Fallback: keep interface shape but perform no logging. This avoids
  // breaking server startup while still surfacing the configuration issue
  // via the warnings above.
  return {
    logModule() {},
    logProviderRequest() {},
    logVirtualRouterHit() {},
    logDebug() {},
    logError() {}
  };
}
