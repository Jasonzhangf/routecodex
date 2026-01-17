import { createRequire } from 'module';

// Local colored logger wrapper that stays aligned with the bundled pipeline utils
// implementation in dist. We resolve ColoredLogger directly from the compiled
// modules/ tree using a module-local require,避免依赖全局 require 造成路径错误。

const localRequire = createRequire(import.meta.url);

export function createServerColoredLogger(): unknown {
  const isDev = String(process.env.BUILD_MODE || process.env.RCC_BUILD_MODE || 'release').toLowerCase() === 'dev';

  try {
    // In test environment (jest), we cannot use localRequire to load ESM modules
    // Fallback to static import if possible or return dummy logger for tests
    if (process.env.NODE_ENV === 'test') {
      return {
        log: () => {},
        logModule: () => {},
        logStage: () => {},
        logProviderRequest: () => {},
        warn: () => {},
        error: () => {}
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = localRequire('../../../modules/pipeline/utils/colored-logger.js');
    const modRecord = mod as Record<string, unknown>;
    const ColoredLogger = modRecord.ColoredLogger || modRecord.default || null;

    if (typeof ColoredLogger === 'function') {
      return new (ColoredLogger as new (options: { isDev: boolean }) => unknown)({ isDev });
    }

    // If the module loaded but ColoredLogger is missing, emit a warning and fall back to a no-op logger.
    console.warn('[routecodex] ColoredLogger export not found in dist index; colored logs (provider/virtual-router) are disabled.');
  } catch (err) {
    // If require fails entirely, warn once and fall back to a no-op logger.
    console.warn('[routecodex] Failed to load ColoredLogger from dist index; colored logs (provider/virtual-router) are disabled.', err);
  }

  // Fallback: keep interface shape but perform no logging.
  return {
    log: () => {},
    logModule: () => {},
    logStage: () => {},
    logProviderRequest: () => {},
    warn: () => {},
    error: () => {}
  };
}
