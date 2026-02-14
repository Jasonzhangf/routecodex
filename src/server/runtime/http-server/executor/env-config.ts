/**
 * Environment Configuration for request-executor
 *
 * Resolves runtime configuration from environment variables.
 */

import { resolveBoolFromEnv } from './utils.js';
import { buildInfo } from '../../../../build-info.js';

/**
 * Check if usage logging is enabled
 */
export function isUsageLoggingEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_USAGE_LOG ?? process.env.RCC_USAGE_LOG,
    buildInfo.mode !== 'release'
  );
}

/**
 * Check if verbose error logging is enabled
 */
export function isVerboseErrorLoggingEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_ERROR_VERBOSE ?? process.env.RCC_ERROR_VERBOSE,
    false
  );
}