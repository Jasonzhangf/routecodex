/**
 * ProviderForwarder 适配入口 —— 统一 re-export 给测试和 host。
 *
 * buildForwarderProfiles 实际在 provider-profile-loader.ts（避免循环 import）。
 * validateForwarderId / FORWARDER_ID_PREFIX 在 forwarder-types.ts。
 */

export {
  FORWARDER_ID_PREFIX,
  validateForwarderId,
} from './forwarder-types.js';

export { buildForwarderProfiles } from './provider-profile-loader.js';
