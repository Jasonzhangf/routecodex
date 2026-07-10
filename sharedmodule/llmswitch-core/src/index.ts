/**
 * RouteCodex hub entry exports.
 *
 * Expose hub pipeline + conversion helpers + router bootstrap so consumers no longer
 * have to depend on the removed LLMSwitch V2 engine.
 */

export * from './native/router-hotpath/native-virtual-router-bootstrap-config.js';
export * from './native/router-hotpath/native-provider-runtime-ingress.js';
export * from './native/router-hotpath/native-router-hotpath-loader.js';
export type * from './native/router-hotpath/virtual-router-contracts.js';
export const VERSION = '0.4.0';
